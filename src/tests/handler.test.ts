import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import { createProxyHandler } from '../proxy/handler.js';
import { ProviderManager } from '../providers/providerManager.js';
import { RequestQueue } from '../queue/requestQueue.js';
import { ProviderName } from '../providers/types.js';
import { ProxyConfig } from '../config.js';

// forwardRequest does real network I/O — mock it so the handler tests stay
// deterministic and don't need a live provider.
vi.mock('../proxy/forwardRequest.js', () => ({
  forwardRequest: vi.fn(),
  estimateTokens: (buf: Buffer) => Math.ceil(buf.length / 4),
}));

import { forwardRequest } from '../proxy/forwardRequest.js';
import { metrics } from '../metrics.js';

function makeConfig(overrides?: Partial<ProxyConfig>): ProxyConfig {
  return {
    port: 8080,
    groq: {
      apiKey: 'test-groq-key', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b',
      rateLimitRpm: 30, rateLimitTpm: 100000, rateLimitTpd: 500000, rateLimitRpd: 1000,
    },
    gemini: {
      apiKey: 'test-gemini-key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-lite-latest',
      rateLimitRpm: 15, rateLimitTpm: 1000000, rateLimitTpd: 0, rateLimitRpd: 1500,
    },
    openrouter: {
      apiKey: 'test-or-key', baseUrl: 'https://openrouter.ai/api/v1', model: 'nvidia/nemotron-3-super-120b-a12b:free',
      rateLimitRpm: 20, rateLimitRpd: 50,
    },
    cloudflare: {
      apiToken: 'test-cf-token', accountId: 'test-account', baseUrl: 'https://api.cloudflare.com/client/v4/accounts', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      rateLimitRpm: 300, rateLimitTpd: 10000,
    },
    ollama: { baseUrl: 'http://host.docker.internal:11434/v1', model: 'qwen2.5:7b' },
    activeHoursStart: '07:00',
    activeHoursEnd: '22:00',
    timezone: 'America/Argentina/Buenos_Aires',
    queuePersistPath: null,
    exhaustionThreshold: 0.80,
    waitMaxMs: 20000,
    enableOllama: true,
    providerOrder: ['groq', 'gemini', 'openrouter', 'cloudflare'],
    maxBodyBytes: 5_000_000,
    requestReadTimeoutMs: 30_000,
    ...overrides,
  };
}

/** Builds a minimal fake Express req: a real Readable stream + the fields handler.ts reads. */
function makeReq(body: unknown): any {
  const bodyStr = JSON.stringify(body);
  let sent = false;
  const stream = new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(Buffer.from(bodyStr));
        this.push(null);
      }
    },
  }) as any;
  stream.method = 'POST';
  stream.path = '/v1/chat/completions';
  stream.headers = { 'content-type': 'application/json' };
  return stream;
}

/** Builds a minimal fake Express res, capturing status/body/headers. */
function makeRes(): any {
  const res: any = {
    statusCode: 200,
    headersSent: {} as Record<string, unknown>,
    body: undefined as unknown,
    setHeader(key: string, value: unknown) { this.headersSent[key] = value; },
    status(code: number) { this.statusCode = code; return this; },
    send(body: unknown) { this.body = body; return this; },
    json(obj: unknown) { this.body = obj; return this; },
  };
  return res;
}

function fakeForwardResult(overrides?: Partial<Awaited<ReturnType<typeof forwardRequest>>>) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ choices: [{ message: { content: '{"tags":[]}' } }] })),
    tokensUsed: 42,
    rateLimited: false,
    isDaily: false,
    ...overrides,
  };
}

describe('createProxyHandler', () => {
  beforeEach(() => {
    vi.mocked(forwardRequest).mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T15:00:00Z')); // active hours
    metrics.reset();
  });

  it('forwards to the active provider and passes the response through on success', async () => {
    vi.mocked(forwardRequest).mockResolvedValue(fakeForwardResult());

    const pm = new ProviderManager(makeConfig());
    const queue = new RequestQueue(null);
    const handler = createProxyHandler(pm, queue, 20_000);

    const req = makeReq({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    const res = makeRes();

    await handler(req, res);

    expect(forwardRequest).toHaveBeenCalledTimes(1);
    expect(forwardRequest.mock.calls[0][4].name).toBe(ProviderName.GROQ);
    expect(res.statusCode).toBe(200);
    expect(queue.size()).toBe(0);

    // The fake response body has an empty tags array — that's still a
    // tagging response, so it should be counted (0 tags, "tooFew").
    const snap = metrics.snapshot();
    expect(snap.tagValidation.totalsByProvider[ProviderName.GROQ]?.tooFew).toBe(1);
  });

  it('fails over to the next provider on a 429 before succeeding', async () => {
    vi.mocked(forwardRequest)
      .mockResolvedValueOnce(fakeForwardResult({ status: 429, rateLimited: true, isDaily: false }))
      .mockResolvedValueOnce(fakeForwardResult());

    const pm = new ProviderManager(makeConfig());
    const queue = new RequestQueue(null);
    const handler = createProxyHandler(pm, queue, 20_000);

    const req = makeReq({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    const res = makeRes();

    await handler(req, res);

    expect(forwardRequest).toHaveBeenCalledTimes(2);
    expect(forwardRequest.mock.calls[0][4].name).toBe(ProviderName.GROQ);
    expect(forwardRequest.mock.calls[1][4].name).toBe(ProviderName.GEMINI);
    expect(res.statusCode).toBe(200);
  });

  it('queues the request when no provider is available (waitMaxMs=0)', async () => {
    const pm = new ProviderManager(makeConfig({ providerOrder: [], enableOllama: false }));
    const queue = new RequestQueue(null);
    const handler = createProxyHandler(pm, queue, /* waitMaxMs */ 0);

    const req = makeReq({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    const res = makeRes();

    await handler(req, res);

    expect(forwardRequest).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(202);
    expect(res.body.queued).toBe(true);
    expect(queue.size()).toBe(1);
  });

  it('rejects a body larger than maxBodyBytes with 413', async () => {
    const pm = new ProviderManager(makeConfig());
    const queue = new RequestQueue(null);
    const handler = createProxyHandler(pm, queue, 20_000, /* maxBodyBytes */ 10);

    const req = makeReq({ model: 'x', messages: [{ role: 'user', content: 'this body is way over ten bytes' }] });
    const res = makeRes();

    await handler(req, res);

    expect(forwardRequest).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(413);

    const snap = metrics.snapshot();
    expect(snap.bodyRejections.totals.too_large).toBe(1);
    expect(snap.bodyRejections.recentEvents[0]?.limitBytes).toBe(10);
  });
});
