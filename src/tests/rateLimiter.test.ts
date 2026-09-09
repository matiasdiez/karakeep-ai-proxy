import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter } from '../providers/rateLimiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    // RPM=5, TPM=100, TPD=500, threshold=0.80
    limiter = new RateLimiter(5, 100, 500, 0.80);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── RPM ────────────────────────────────────────────────────────────────────

  it('allows requests below RPM threshold', () => {
    // limit=5, threshold=0.80 → can send up to floor(5*0.80)=4 in a minute
    for (let i = 0; i < 3; i++) {
      limiter.record(0);
    }
    expect(limiter.canSend(0)).toBe(true);
  });

  it('blocks at RPM threshold (80% of limit)', () => {
    // 4 requests = 4/5 = 80% — should be blocked (>= threshold)
    for (let i = 0; i < 4; i++) {
      limiter.record(0);
    }
    expect(limiter.canSend(0)).toBe(false);
  });

  it('recovers after 60s sliding window', () => {
    for (let i = 0; i < 4; i++) {
      limiter.record(0);
    }
    expect(limiter.canSend(0)).toBe(false);

    // Advance 61 seconds
    vi.advanceTimersByTime(61_000);
    expect(limiter.canSend(0)).toBe(true);
  });

  // ── TPM ────────────────────────────────────────────────────────────────────

  it('blocks when TPM threshold exceeded', () => {
    // limit=100, threshold=0.80 → 80 tokens
    limiter.record(79);
    expect(limiter.canSend(2)).toBe(false); // 79+2=81 > 80
  });

  it('allows when TPM exactly at threshold', () => {
    limiter.record(79);
    expect(limiter.canSend(1)).toBe(true); // 79+1=80 = 80% exactly (not strictly greater)
  });

  it('recovers TPM after 60s', () => {
    limiter.record(79);
    expect(limiter.canSend(2)).toBe(false);

    vi.advanceTimersByTime(61_000);
    expect(limiter.canSend(2)).toBe(true);
  });

  // ── TPD ────────────────────────────────────────────────────────────────────

  it('blocks when TPD threshold exceeded', () => {
    // limit=500, threshold=0.80 → 400 tokens daily
    limiter.record(399);
    expect(limiter.canSend(2)).toBe(false); // 399+2=401 > 400
  });

  it('resets daily accumulator on resetDaily()', () => {
    // Use a limiter where TPD=500 is the binding constraint (RPM/TPM are large)
    const tpdLimiter = new RateLimiter(100, 100000, 500, 0.80);
    // threshold = 400 tokens/day
    tpdLimiter.record(399);
    expect(tpdLimiter.canSend(2)).toBe(false); // 399+2=401 > 400
    tpdLimiter.resetDaily();
    expect(tpdLimiter.canSend(2)).toBe(true);
  });

  it('returns correct stats', () => {
    limiter.record(30);
    const stats = limiter.getStats();
    expect(stats.rpm.used).toBe(1);
    expect(stats.tpm.used).toBe(30);
    expect(stats.tpd?.used).toBe(30);
  });

  // ── RPD ────────────────────────────────────────────────────────────────────

  it('blocks when RPD threshold exceeded', () => {
    // RPM=100, TPM=10000, TPD=0, threshold=0.80, RPD=10 -> threshold = 8 requests daily
    const rpdLimiter = new RateLimiter(100, 10000, 0, 0.80, 10);
    for (let i = 0; i < 8; i++) {
      rpdLimiter.record(10);
    }
    expect(rpdLimiter.canSend(10)).toBe(false); // 8+1=9 > 8
  });

  it('markDailyExhausted blocks requests until daily reset', () => {
    const rpdLimiter = new RateLimiter(100, 10000, 0, 0.80, 10);
    expect(rpdLimiter.canSend(10)).toBe(true);

    rpdLimiter.markDailyExhausted();
    expect(rpdLimiter.canSend(10)).toBe(false);

    // Sliding window of 60s passes, still blocked because it is daily
    vi.advanceTimersByTime(61_000);
    expect(rpdLimiter.canSend(10)).toBe(false);

    // Reset daily -> unblocked
    rpdLimiter.resetDaily();
    expect(rpdLimiter.canSend(10)).toBe(true);
  });

  it('returns correct rpd stats', () => {
    const rpdLimiter = new RateLimiter(100, 10000, 0, 0.80, 10);
    rpdLimiter.record(10);
    const stats = rpdLimiter.getStats();
    expect(stats.rpd?.used).toBe(1);
    expect(stats.rpd?.limit).toBe(10);
  });
});
