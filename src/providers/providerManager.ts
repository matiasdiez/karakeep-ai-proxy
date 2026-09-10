import { ProxyConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { ProviderName, ProviderStats } from './types.js';
import { RateLimiter } from './rateLimiter.js';

const logger = createLogger('ProviderManager');

export interface ActiveProvider {
  name: ProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * State machine managing which provider is currently active.
 *
 * Priority / fallback order (during active hours):
 *   providerOrder[0] → providerOrder[1] → ... → WAITING (queue)
 *
 * "Active hours" are the configured daytime window (ACTIVE_HOURS_START–
 * ACTIVE_HOURS_END). Outside that window, if Ollama is enabled, it's used
 * directly — the cloud cascade above is skipped entirely so free-tier quota
 * is preserved for daytime traffic. If Ollama is disabled, the cloud cascade
 * runs regardless of time of day.
 */
export class ProviderManager {
  private readonly config: ProxyConfig;

  private readonly groqLimiter: RateLimiter;
  private readonly geminiLimiter: RateLimiter;
  private readonly openrouterLimiter: RateLimiter;
  private readonly cloudflareLimiter: RateLimiter;

  private groqExhausted = false;
  private geminiExhausted = false;

  /** Timestamp when each provider was marked exhausted (for logging) */
  private groqExhaustedAt: number | null = null;
  private geminiExhaustedAt: number | null = null;

  private openrouterExhausted = false;
  private cloudflareExhausted = false;
  private openrouterExhaustedAt: number | null = null;
  private cloudflareExhaustedAt: number | null = null;

  constructor(config: ProxyConfig) {
    this.config = config;

    this.groqLimiter = new RateLimiter(
      config.groq.rateLimitRpm,
      config.groq.rateLimitTpm,
      config.groq.rateLimitTpd,
      config.exhaustionThreshold,
      config.groq.rateLimitRpd,
    );

    this.geminiLimiter = new RateLimiter(
      config.gemini.rateLimitRpm,
      config.gemini.rateLimitTpm,
      config.gemini.rateLimitTpd,
      config.exhaustionThreshold,
      config.gemini.rateLimitRpd,
    );

    this.openrouterLimiter = new RateLimiter(
      config.openrouter?.rateLimitRpm ?? 20,
      0, // no tpm limit
      0, // no tpd limit
      config.exhaustionThreshold,
      config.openrouter?.rateLimitRpd ?? 50,
    );

    this.cloudflareLimiter = new RateLimiter(
      config.cloudflare?.rateLimitRpm ?? 300,
      0, // no tpm limit
      config.cloudflare?.rateLimitTpd ?? 10000, // daily neuron limit in TPD position
      config.exhaustionThreshold,
      0, // no rpd limit
    );
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Returns the provider that should handle the next request, or null if no
   * provider is available (requests should be queued).
   */
  getActiveProvider(tokenEstimate = 500): ActiveProvider | null {
    // Outside active hours, prefer Ollama directly — this is the whole point
    // of having a local fallback: save cloud free-tier quota for daytime use
    // instead of burning through it overnight just because it's available.
    if (!this.isInActiveHours() && this.config.enableOllama) {
      return this.ollamaProvider();
    }

    // Try cloud providers in priority order
    for (const provider of this.config.providerOrder) {
      if (provider === 'groq' && !this.groqExhausted && this.groqLimiter.canSend(tokenEstimate)) {
        return {
          name: ProviderName.GROQ,
          baseUrl: this.config.groq.baseUrl,
          apiKey: this.config.groq.apiKey,
          model: this.config.groq.model,
        };
      }
      
      if (provider === 'gemini' && !this.geminiExhausted && this.geminiLimiter.canSend(tokenEstimate)) {
        return {
          name: ProviderName.GEMINI,
          baseUrl: this.config.gemini.baseUrl,
          apiKey: this.config.gemini.apiKey,
          model: this.config.gemini.model,
        };
      }
      
      if (provider === 'openrouter' && !this.openrouterExhausted && this.openrouterLimiter.canSend(tokenEstimate)) {
        return {
          name: ProviderName.OPENROUTER,
          baseUrl: this.config.openrouter.baseUrl,
          apiKey: this.config.openrouter.apiKey,
          model: this.config.openrouter.model,
        };
      }
      
      if (provider === 'cloudflare' && !this.cloudflareExhausted && this.cloudflareLimiter.canSend(tokenEstimate)) {
        const base = this.config.cloudflare.baseUrl.replace(/\/$/, '');
        const fullBaseUrl = base.includes(this.config.cloudflare.accountId)
          ? base
          : `${base}/${this.config.cloudflare.accountId}/ai/v1`;

        return {
          name: ProviderName.CLOUDFLARE,
          baseUrl: fullBaseUrl,
          apiKey: this.config.cloudflare.apiToken, // Note: Cloudflare uses apiToken
          model: this.config.cloudflare.model,
        };
      }
    }

    // All cloud providers exhausted. Check if Ollama is enabled
    if (this.config.enableOllama) {
      return this.ollamaProvider();
    }

    // No provider available → queue
    return null;
  }

  /**
   * Mark a provider as exhausted (e.g. after a real 429 response).
   * If isDaily is true, the provider's daily accumulator is marked exhausted
   * so it will remain disabled until the midnight daily reset.
   */
  markExhausted(name: ProviderName, isDaily = false): void {
    if (name === ProviderName.GROQ) {
      if (!this.groqExhausted) {
        this.groqExhausted = true;
        this.groqExhaustedAt = Date.now();
      }
      if (isDaily) {
        this.groqLimiter.markDailyExhausted();
        logger.warn('Groq marked daily exhausted (RPD/TPD limit reached until midnight)');
      } else {
        logger.warn('Groq marked exhausted (hard 429, cooling down)');
      }
    } else if (name === ProviderName.GEMINI) {
      if (!this.geminiExhausted) {
        this.geminiExhausted = true;
        this.geminiExhaustedAt = Date.now();
      }
      if (isDaily) {
        this.geminiLimiter.markDailyExhausted();
        logger.warn('Gemini marked daily exhausted (RPD/TPD limit reached until midnight)');
      } else {
        logger.warn('Gemini marked exhausted (hard 429, cooling down)');
      }
    } else if (name === ProviderName.OPENROUTER) {
      if (!this.openrouterExhausted) {
        this.openrouterExhausted = true;
        this.openrouterExhaustedAt = Date.now();
      }
      if (isDaily) {
        this.openrouterLimiter.markDailyExhausted();
        logger.warn('OpenRouter marked daily exhausted (credit limit reached)');
      } else {
        logger.warn('OpenRouter marked exhausted (hard 429, cooling down)');
      }
    } else if (name === ProviderName.CLOUDFLARE) {
      if (!this.cloudflareExhausted) {
        this.cloudflareExhausted = true;
        this.cloudflareExhaustedAt = Date.now();
      }
      if (isDaily) {
        this.cloudflareLimiter.markDailyExhausted();
        logger.warn('Cloudflare marked daily exhausted (neuron limit reached until UTC 00:00)');
      } else {
        logger.warn('Cloudflare marked exhausted (hard 429, cooling down)');
      }
    }
  }

  /**
   * Record actual token usage for the given provider after a successful call.
   */
  recordUsage(name: ProviderName, tokens: number): void {
    if (name === ProviderName.GROQ) {
      this.groqLimiter.record(tokens);
    } else if (name === ProviderName.GEMINI) {
      this.geminiLimiter.record(tokens);
    } else if (name === ProviderName.OPENROUTER) {
      this.openrouterLimiter.record(tokens);
    } else if (name === ProviderName.CLOUDFLARE) {
      this.cloudflareLimiter.record(tokens);
    }
    // Ollama has no rate limiting
  }

  /**
   * Check whether any exhausted provider has recovered quota.
   * Enforces a minimum cooldown (60s) after a hard 429 before checking if canSend(0) is true.
   */
  checkRecovery(): void {
    const COOLDOWN_MS = 60_000;
    const now = Date.now();

    if (this.groqExhausted) {
      const elapsed = now - (this.groqExhaustedAt ?? 0);
      if (elapsed >= COOLDOWN_MS && this.groqLimiter.canSend(0)) {
        this.groqExhausted = false;
        this.groqExhaustedAt = null;
        logger.info('Groq quota recovered — re-enabling');
      }
    }

    if (this.geminiExhausted) {
      const elapsed = now - (this.geminiExhaustedAt ?? 0);
      if (elapsed >= COOLDOWN_MS && this.geminiLimiter.canSend(0)) {
        this.geminiExhausted = false;
        this.geminiExhaustedAt = null;
        logger.info('Gemini quota recovered — re-enabling');
      }
    }

    if (this.openrouterExhausted) {
      const elapsed = now - (this.openrouterExhaustedAt ?? 0);
      if (elapsed >= COOLDOWN_MS && this.openrouterLimiter.canSend(0)) {
        this.openrouterExhausted = false;
        this.openrouterExhaustedAt = null;
        logger.info('OpenRouter quota recovered — re-enabling');
      }
    }

    if (this.cloudflareExhausted) {
      const elapsed = now - (this.cloudflareExhaustedAt ?? 0);
      if (elapsed >= COOLDOWN_MS && this.cloudflareLimiter.canSend(0)) {
        this.cloudflareExhausted = false;
        this.cloudflareExhaustedAt = null;
        logger.info('Cloudflare quota recovered — re-enabling');
      }
    }
  }

  /**
   * Returns true if the current local time falls within the active hours window.
   */
  isInActiveHours(): boolean {
    return isInActiveHours(
      this.config.activeHoursStart,
      this.config.activeHoursEnd,
      this.config.timezone,
    );
  }

  getStats(): {
    activeProvider: string;
    activeHours: boolean;
    providers: {
      groq: ProviderStats;
      gemini: ProviderStats;
      openrouter: ProviderStats;
      cloudflare: ProviderStats;
      ollama: { name: ProviderName; active: boolean };
    };
  } {
    const activeHours = this.isInActiveHours();
    const groqStats = this.groqLimiter.getStats();
    const geminiStats = this.geminiLimiter.getStats();
    const openrouterStats = this.openrouterLimiter.getStats();
    const cloudflareStats = this.cloudflareLimiter.getStats();

    let activeProvider = 'WAITING';
    if (!activeHours && this.config.enableOllama) {
      activeProvider = 'OLLAMA';
    } else {
      for (const provider of this.config.providerOrder) {
        if (provider === 'groq' && !this.groqExhausted && this.groqLimiter.canSend(0)) {
          activeProvider = 'GROQ';
          break;
        } else if (provider === 'gemini' && !this.geminiExhausted && this.geminiLimiter.canSend(0)) {
          activeProvider = 'GEMINI';
          break;
        } else if (provider === 'openrouter' && !this.openrouterExhausted && this.openrouterLimiter.canSend(0)) {
          activeProvider = 'OPENROUTER';
          break;
        } else if (provider === 'cloudflare' && !this.cloudflareExhausted && this.cloudflareLimiter.canSend(0)) {
          activeProvider = 'CLOUDFLARE';
          break;
        }
      }

      if (activeProvider === 'WAITING' && this.config.enableOllama) {
        activeProvider = 'OLLAMA';
      }
    }

    return {
      activeProvider,
      activeHours,
      providers: {
        groq: {
          name: ProviderName.GROQ,
          exhausted: this.groqExhausted,
          exhaustedAt: this.groqExhaustedAt,
          rpm: groqStats.rpm,
          tpm: groqStats.tpm,
          tpd: groqStats.tpd,
          rpd: groqStats.rpd,
        },
        gemini: {
          name: ProviderName.GEMINI,
          exhausted: this.geminiExhausted,
          exhaustedAt: this.geminiExhaustedAt,
          rpm: geminiStats.rpm,
          tpm: geminiStats.tpm,
          tpd: geminiStats.tpd,
          rpd: geminiStats.rpd,
        },
        openrouter: {
          name: ProviderName.OPENROUTER,
          exhausted: this.openrouterExhausted,
          exhaustedAt: this.openrouterExhaustedAt,
          rpm: openrouterStats.rpm,
          tpm: openrouterStats.tpm,
          tpd: null,
          rpd: openrouterStats.rpd,
        },
        cloudflare: {
          name: ProviderName.CLOUDFLARE,
          exhausted: this.cloudflareExhausted,
          exhaustedAt: this.cloudflareExhaustedAt,
          rpm: cloudflareStats.rpm,
          tpm: null,
          tpd: cloudflareStats.tpd,
          rpd: null,
        },
        ollama: {
          name: ProviderName.OLLAMA,
          active: this.config.enableOllama,
        },
      },
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private ollamaProvider(): ActiveProvider {
    return {
      name: ProviderName.OLLAMA,
      baseUrl: this.config.ollama.baseUrl,
      apiKey: 'ollama',
      model: this.config.ollama.model,
    };
  }
}

/**
 * Pure function (exported for testing) that checks whether the current time
 * in the given timezone is within [start, end).
 */
export function isInActiveHours(start: string, end: string, timezone: string, now?: Date): boolean {
  const date = now ?? new Date();

  // Get current time in the target timezone as "HH:MM"
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  });

  const parts = formatter.formatToParts(date);
  const hour = parts.find(p => p.type === 'hour')?.value ?? '00';
  const minute = parts.find(p => p.type === 'minute')?.value ?? '00';
  const current = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;

  // Handle midnight-crossing windows (e.g. 22:00 → 07:00 — unusual but supported)
  if (start <= end) {
    return current >= start && current < end;
  } else {
    return current >= start || current < end;
  }
}
