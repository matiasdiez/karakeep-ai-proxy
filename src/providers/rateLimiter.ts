import { RateLimitStats } from './types.js';

interface RequestRecord {
  timestamp: number; // ms
  tokens: number;
}

/**
 * Sliding-window rate limiter tracking RPM, TPM, and TPD.
 *
 * - RPM / TPM: computed over the last 60 seconds (sliding window)
 * - TPD: running accumulator that resets at midnight UTC (or at the configured timezone via the
 *   caller passing the reset signal — see resetDaily())
 */
export class RateLimiter {
  private readonly limitRpm: number;
  private readonly limitTpm: number;
  private readonly limitTpd: number; // 0 = disabled
  private readonly limitRpd: number; // 0 = disabled

  private readonly threshold: number; // e.g. 0.80

  /** Requests in the last 60 s */
  private window: RequestRecord[] = [];

  /** Daily token accumulator */
  private dailyTokens = 0;
  /** Daily request accumulator */
  private dailyRequests = 0;
  private dailyResetAt: number; // timestamp of the next midnight reset

  constructor(
    limitRpm: number,
    limitTpm: number,
    limitTpd: number,
    threshold: number,
    limitRpd = 0,
  ) {
    this.limitRpm = limitRpm;
    this.limitTpm = limitTpm;
    this.limitTpd = limitTpd;
    this.limitRpd = limitRpd;
    this.threshold = threshold;
    this.dailyResetAt = nextMidnightUtc();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Returns true if sending a request with the given token estimate would stay
   * under the configured thresholds for all active limits.
   */
  canSend(tokenEstimate: number): boolean {
    this.evict();
    this.maybeResetDaily();

    const rpm = this.window.length;
    const tpm = this.window.reduce((s, r) => s + r.tokens, 0);

    if (this.limitRpm > 0 && rpm + 1 > this.limitRpm * this.threshold) return false;
    if (this.limitTpm > 0 && tpm + tokenEstimate > this.limitTpm * this.threshold) return false;
    if (this.limitTpd > 0 && this.dailyTokens + tokenEstimate > this.limitTpd * this.threshold) return false;
    if (this.limitRpd > 0 && this.dailyRequests + 1 > this.limitRpd * this.threshold) return false;

    return true;
  }

  /**
   * Record that a request was sent with the given actual token count.
   * Call this after a successful response so we can use real usage data.
   */
  record(tokens: number): void {
    this.evict();
    this.maybeResetDaily();

    this.window.push({ timestamp: Date.now(), tokens });
    this.dailyTokens += tokens;
    this.dailyRequests += 1;
  }

  /**
   * Mark daily quota as exhausted (e.g. after receiving a hard 429 daily limit error).
   * Ensures canSend() remains false until the daily reset.
   */
  markDailyExhausted(): void {
    this.evict();
    this.maybeResetDaily();
    const exhaustedCount = this.limitRpd > 0 ? this.limitRpd : 1;
    this.dailyRequests = Math.max(this.dailyRequests, exhaustedCount);
  }

  /**
   * Force a daily reset (e.g. called at midnight by an external scheduler).
   */
  resetDaily(): void {
    this.dailyTokens = 0;
    this.dailyRequests = 0;
    this.dailyResetAt = nextMidnightUtc();
  }

  getStats(): {
    rpm: RateLimitStats;
    tpm: RateLimitStats;
    tpd: RateLimitStats | null;
    rpd: RateLimitStats | null;
  } {
    this.evict();
    this.maybeResetDaily();

    const rpm = this.window.length;
    const tpm = this.window.reduce((s, r) => s + r.tokens, 0);

    return {
      rpm: { used: rpm, limit: this.limitRpm, pct: rpm / this.limitRpm },
      tpm: { used: tpm, limit: this.limitTpm, pct: this.limitTpm > 0 ? tpm / this.limitTpm : 0 },
      tpd: this.limitTpd > 0
        ? { used: this.dailyTokens, limit: this.limitTpd, pct: this.dailyTokens / this.limitTpd }
        : null,
      rpd: this.limitRpd > 0
        ? { used: this.dailyRequests, limit: this.limitRpd, pct: this.dailyRequests / this.limitRpd }
        : null,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Remove records older than 60 s from the sliding window. */
  private evict(): void {
    const cutoff = Date.now() - 60_000;
    this.window = this.window.filter(r => r.timestamp > cutoff);
  }

  private maybeResetDaily(): void {
    if (Date.now() >= this.dailyResetAt) {
      this.dailyTokens = 0;
      this.dailyRequests = 0;
      this.dailyResetAt = nextMidnightUtc();
    }
  }
}

function nextMidnightUtc(): number {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return midnight.getTime();
}
