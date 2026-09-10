import https from 'https';
import http from 'http';
import { URL } from 'url';
import { IncomingMessage } from 'http';
import { createLogger } from '../logger.js';
import { ActiveProvider } from '../providers/providerManager.js';
import { ProviderName } from '../providers/types.js';

const logger = createLogger('ForwardRequest');

export interface ForwardResult {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  /** Actual token usage extracted from response, if available */
  tokensUsed: number;
  /** True if the provider returned a hard 429 */
  rateLimited: boolean;
  /** True if the 429 indicates a daily limit was reached (RPD / TPD) */
  isDaily: boolean;
}

/**
 * Forwards a single request to the given provider, adapting the URL, auth
 * header, and model field.
 *
 * Returns a ForwardResult with the raw response so the caller can decide
 * whether to failover, queue, or pass through to Karakeep.
 */
export async function forwardRequest(
  method: string,
  urlPath: string,
  incomingHeaders: Record<string, string>,
  rawBody: Buffer,
  provider: ActiveProvider,
): Promise<ForwardResult> {
  // ── Adapt URL ──────────────────────────────────────────────────────────────
  // Karakeep envía /v1/chat/completions. Quitamos el /v1 de adelante porque
  // el baseUrl del proveedor ya lo incluye (ej. https://api.groq.com/openai/v1).
  // IMPORTANTE: usamos concatenación de strings, NO new URL(path, base), porque
  // new URL() con un path absoluto (empieza con /) REEMPLAZA el path de la base,
  // descartando /openai/v1 y resultando en 404 del proveedor.
  const strippedPath = urlPath.replace(/^\/v1/, '');
  const baseWithoutTrailingSlash = provider.baseUrl.replace(/\/$/, '');
  const targetUrl = new URL(baseWithoutTrailingSlash + strippedPath);

  // ── Adapt body: rewrite model field ────────────────────────────────────────
  let bodyBuffer = rawBody;
  const contentType = incomingHeaders['content-type'] ?? '';
  if (contentType.includes('application/json') && rawBody.length > 0) {
    try {
      const parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
      parsed['model'] = provider.model;
      bodyBuffer = Buffer.from(JSON.stringify(parsed), 'utf8');
    } catch {
      // If JSON parse fails, forward as-is
      logger.warn('Could not parse request body as JSON — forwarding as-is');
    }
  }

  // ── Build outgoing headers ─────────────────────────────────────────────────
  const outHeaders: Record<string, string> = {
    'content-type': contentType || 'application/json',
    'content-length': String(bodyBuffer.length),
    'authorization': `Bearer ${provider.apiKey}`,
    'accept': incomingHeaders['accept'] ?? 'application/json',
  };

  // OpenRouter-specific headers
  if (provider.name === ProviderName.OPENROUTER) {
    outHeaders['HTTP-Referer'] = 'http://localhost:3000';
    outHeaders['X-Title'] = 'Karakeep';
  }

  // Forward user-agent if present
  if (incomingHeaders['user-agent']) {
    outHeaders['user-agent'] = incomingHeaders['user-agent'];
  }

  logger.info(`→ ${provider.name.toUpperCase()} ${method} ${targetUrl.pathname}`, {
    model: provider.model,
    bodyBytes: bodyBuffer.length,
  });

  // ── Make the request ───────────────────────────────────────────────────────
  const responseRaw = await makeRequest(method, targetUrl, outHeaders, bodyBuffer);

  // ── Parse token usage from response ───────────────────────────────────────
  let tokensUsed = 0;
  let rateLimited = false;
  let isDaily = false;

  if (responseRaw.status === 402 && provider.name === ProviderName.OPENROUTER) {
    // OpenRouter: insufficient credits
    rateLimited = true;
    isDaily = true; // Treat as daily limit (soft exhaustion)
    logger.warn(`← OPENROUTER 402 insufficient credits: ${responseRaw.body.toString('utf8').slice(0, 300)}`);
  } else if (responseRaw.status === 429) {
    rateLimited = true;
    const bodyText = responseRaw.body.toString('utf8');
    logger.warn(`← ${provider.name.toUpperCase()} 429 rate limited: ${bodyText.slice(0, 300)}`);
    if (
      bodyText.includes('requests per day') ||
      bodyText.includes('RPD') ||
      bodyText.includes('PerDay') ||
      bodyText.includes('daily') ||
      bodyText.includes('tokens per day') ||
      bodyText.includes('RESOURCE_EXHAUSTED') ||
      bodyText.includes('free-models-per-day') ||
      bodyText.includes('free_tier_daily')
    ) {
      isDaily = true;
    }
  } else if (responseRaw.status >= 200 && responseRaw.status < 300) {
    // Special handling for Cloudflare response format
    if (provider.name === ProviderName.CLOUDFLARE) {
      try {
        const parsed = JSON.parse(responseRaw.body.toString('utf8')) as Record<string, unknown>;
        const usage = (parsed['usage'] as Record<string, number> | undefined)
          ?? ((parsed['result'] as Record<string, unknown> | undefined)?.['usage'] as Record<string, number> | undefined);
        if (usage) {
          tokensUsed = (usage['total_tokens'] as number) ?? (usage['cf_tokens_used'] as number) ?? (usage['tokens_used'] as number) ?? 0;
        }
      } catch {
        // Non-JSON response — token count stays 0
      }
      logger.info(`← CLOUDFLARE ${responseRaw.status} (${tokensUsed} tokens)`);
    } else {
      try {
        const parsed = JSON.parse(responseRaw.body.toString('utf8')) as Record<string, unknown>;
        const usage = parsed['usage'] as Record<string, number> | undefined;
        if (usage) {
          tokensUsed = (usage['total_tokens'] as number) ?? (usage['completion_tokens'] as number) ?? 0;
        }
      } catch {
        // Non-JSON or streaming response — token count stays 0
      }
      logger.info(`← ${provider.name.toUpperCase()} ${responseRaw.status} (${tokensUsed} tokens)`);
    }
  }

  return {
    status: responseRaw.status,
    headers: responseRaw.headers,
    body: responseRaw.body,
    tokensUsed,
    rateLimited,
    isDaily,
  };
}

// ── Low-level HTTP helper ────────────────────────────────────────────────────

interface RawResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

function makeRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: Buffer,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 60_000, // 60 s
    };

    const req = lib.request(options, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 500,
          headers: res.headers as Record<string, string | string[]>,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Request to ${url.href} timed out after 60s`));
    });

    if (body.length > 0) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Estimate tokens for a request body before sending (used by canSend()).
 * Simple heuristic: ~4 chars per token.
 */
export function estimateTokens(body: Buffer): number {
  return Math.ceil(body.length / 4);
}

/**
 * Map a ProviderName to a display string (for logging).
 */
export function providerLabel(name: ProviderName): string {
  return name.toUpperCase();
}
