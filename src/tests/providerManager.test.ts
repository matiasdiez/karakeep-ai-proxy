import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderManager } from '../providers/providerManager.js';
import { ProviderName } from '../providers/types.js';
import { ProxyConfig } from '../config.js';

// A config with limits large enough that the 500-token default estimate
// in getActiveProvider() doesn't trip the threshold unexpectedly.
function makeConfig(overrides?: Partial<ProxyConfig>): ProxyConfig {
  return {
    port: 8080,
    groq: {
      apiKey: 'test-groq-key',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-20b',
      rateLimitRpm: 10,
      rateLimitTpm: 100000,  // large so 500-token estimates don't trigger threshold
      rateLimitTpd: 500000,
      rateLimitRpd: 1000,
    },
    gemini: {
      apiKey: 'test-gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-flash-lite-latest',
      rateLimitRpm: 5,
      rateLimitTpm: 100000,
      rateLimitTpd: 500000,
      rateLimitRpd: 1500,
    },
    openrouter: {
      apiKey: 'test-openrouter-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
      rateLimitRpm: 20,
      rateLimitRpd: 50,
    },
    cloudflare: {
      apiToken: 'test-cloudflare-token',
      accountId: 'test-account-id',
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts',
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      rateLimitRpm: 300,
      rateLimitTpd: 10000,
    },
    ollama: {
      baseUrl: 'http://host.docker.internal:11434/v1',
      model: 'qwen2.5:7b',
    },
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

describe('ProviderManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default: set time to midday ART (active hours)
    // 2026-01-15 12:00 ART = 15:00 UTC
    vi.setSystemTime(new Date('2026-01-15T15:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Active hours ────────────────────────────────────────────────────────────

  it('returns Groq as default provider during active hours', () => {
    const pm = new ProviderManager(makeConfig());
    const provider = pm.getActiveProvider();
    expect(provider?.name).toBe(ProviderName.GROQ);
  });

  it('returns Ollama outside active hours (night)', () => {
    // 23:00 ART = 02:00 UTC
    vi.setSystemTime(new Date('2026-01-16T02:00:00Z'));
    const pm = new ProviderManager(makeConfig());
    const provider = pm.getActiveProvider();
    expect(provider?.name).toBe(ProviderName.OLLAMA);
  });

  // ── Failover ────────────────────────────────────────────────────────────────

  it('failovers from Groq to Gemini on markExhausted(GROQ)', () => {
    const pm = new ProviderManager(makeConfig());

    expect(pm.getActiveProvider()?.name).toBe(ProviderName.GROQ);

    pm.markExhausted(ProviderName.GROQ);
    expect(pm.getActiveProvider()?.name).toBe(ProviderName.GEMINI);
  });

  it('falls over through the full cascade before returning null', () => {
    const pm = new ProviderManager(makeConfig());
    expect(pm.getActiveProvider()?.name).toBe(ProviderName.GROQ);

    pm.markExhausted(ProviderName.GROQ);
    expect(pm.getActiveProvider()?.name).toBe(ProviderName.GEMINI);

    pm.markExhausted(ProviderName.GEMINI);
    expect(pm.getActiveProvider()?.name).toBe(ProviderName.OPENROUTER);

    pm.markExhausted(ProviderName.OPENROUTER);
    expect(pm.getActiveProvider()?.name).toBe(ProviderName.CLOUDFLARE);

    pm.markExhausted(ProviderName.CLOUDFLARE);
    // All 4 cloud providers exhausted, and it's active hours → falls to Ollama.
    expect(pm.getActiveProvider()?.name).toBe(ProviderName.OLLAMA);
  });

  it('returns null when all cloud providers are exhausted and Ollama is disabled', () => {
    const pm = new ProviderManager(makeConfig({ enableOllama: false }));
    pm.markExhausted(ProviderName.GROQ);
    pm.markExhausted(ProviderName.GEMINI);
    pm.markExhausted(ProviderName.OPENROUTER);
    pm.markExhausted(ProviderName.CLOUDFLARE);
    expect(pm.getActiveProvider()).toBeNull();
  });

  // ── Proactive exhaustion via RPM threshold ──────────────────────────────────

  it('failovers to Gemini when Groq RPM threshold reached', () => {
    const pm = new ProviderManager(makeConfig({ exhaustionThreshold: 0.80 }));

    // RPM limit = 10, threshold = 80% → 8 requests
    for (let i = 0; i < 8; i++) {
      pm.recordUsage(ProviderName.GROQ, 10);
    }

    // 9th request: rpm used = 8, limit = 10, 8+1=9 > 8 (threshold)
    const provider = pm.getActiveProvider();
    expect(provider?.name).toBe(ProviderName.GEMINI);
  });

  // ── Recovery ────────────────────────────────────────────────────────────────

  it('does not re-enable Groq before 60s cooldown even if sliding window is empty', () => {
    const pm = new ProviderManager(makeConfig());
    pm.markExhausted(ProviderName.GROQ);

    // Advance only 30 seconds
    vi.advanceTimersByTime(30_000);
    pm.checkRecovery();

    expect(pm.getActiveProvider()?.name).toBe(ProviderName.GEMINI);
  });

  it('re-enables Groq after markExhausted + 60s cooldown clears', () => {
    const pm = new ProviderManager(makeConfig());
    pm.markExhausted(ProviderName.GROQ);

    expect(pm.getActiveProvider()?.name).toBe(ProviderName.GEMINI);

    // Advance 61 seconds — cooldown clears
    vi.advanceTimersByTime(61_000);
    pm.checkRecovery();

    expect(pm.getActiveProvider()?.name).toBe(ProviderName.GROQ);
  });

  it('keeps provider exhausted if marked daily exhausted until resetDaily', () => {
    const pm = new ProviderManager(makeConfig());
    pm.markExhausted(ProviderName.GROQ, true);

    expect(pm.getActiveProvider()?.name).toBe(ProviderName.GEMINI);

    // Advance 120 seconds
    vi.advanceTimersByTime(120_000);
    pm.checkRecovery();

    // Still exhausted because daily quota was exceeded
    expect(pm.getActiveProvider()?.name).toBe(ProviderName.GEMINI);
  });

  // ── getStats ────────────────────────────────────────────────────────────────

  it('getStats reflects active provider correctly', () => {
    const pm = new ProviderManager(makeConfig());
    const stats = pm.getStats();

    expect(stats.activeProvider).toBe('GROQ');
    expect(stats.activeHours).toBe(true);
    expect(stats.providers.groq.exhausted).toBe(false);
    expect(stats.providers.gemini.exhausted).toBe(false);
  });

  it('getStats shows OLLAMA when outside active hours', () => {
    vi.setSystemTime(new Date('2026-01-16T02:00:00Z'));
    const pm = new ProviderManager(makeConfig());
    const stats = pm.getStats();

    expect(stats.activeProvider).toBe('OLLAMA');
    expect(stats.activeHours).toBe(false);
  });

  it('getStats shows WAITING when all cloud providers are exhausted and Ollama is disabled', () => {
    const pm = new ProviderManager(makeConfig({ enableOllama: false }));
    pm.markExhausted(ProviderName.GROQ);
    pm.markExhausted(ProviderName.GEMINI);
    pm.markExhausted(ProviderName.OPENROUTER);
    pm.markExhausted(ProviderName.CLOUDFLARE);

    const stats = pm.getStats();
    expect(stats.activeProvider).toBe('WAITING');
  });

  // ── Model mapping ───────────────────────────────────────────────────────────

  it('returns correct model for each provider', () => {
    const pm = new ProviderManager(makeConfig());

    const groq = pm.getActiveProvider();
    expect(groq?.model).toBe('openai/gpt-oss-20b');

    pm.markExhausted(ProviderName.GROQ);
    const gemini = pm.getActiveProvider();
    expect(gemini?.model).toBe('gemini-flash-lite-latest');

    // Night time
    vi.setSystemTime(new Date('2026-01-16T02:00:00Z'));
    const pm2 = new ProviderManager(makeConfig());
    const ollama = pm2.getActiveProvider();
    expect(ollama?.model).toBe('qwen2.5:7b');
  });
});
