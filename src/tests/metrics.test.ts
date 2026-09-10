import { describe, it, expect, beforeEach } from 'vitest';
import { metrics } from '../metrics.js';

describe('metrics', () => {
  beforeEach(() => {
    metrics.reset();
  });

  describe('recordBodyRejection', () => {
    it('tracks totals per reason independently', () => {
      metrics.recordBodyRejection('too_large', { bytesReceived: 6_000_000, limitBytes: 5_000_000 });
      metrics.recordBodyRejection('too_large', { bytesReceived: 7_000_000, limitBytes: 5_000_000 });
      metrics.recordBodyRejection('read_timeout', { elapsedMs: 30_000, limitMs: 30_000 });

      const snap = metrics.snapshot();
      expect(snap.bodyRejections.totals.too_large).toBe(2);
      expect(snap.bodyRejections.totals.read_timeout).toBe(1);
      expect(snap.bodyRejections.recentEvents).toHaveLength(3);
      expect(snap.bodyRejections.recentEvents[0]?.bytesReceived).toBe(6_000_000);
    });

    it('caps recent events at 50 without losing older totals', () => {
      for (let i = 0; i < 60; i++) {
        metrics.recordBodyRejection('too_large', { bytesReceived: i });
      }
      const snap = metrics.snapshot();
      expect(snap.bodyRejections.totals.too_large).toBe(60);
      expect(snap.bodyRejections.recentEvents).toHaveLength(50);
      // Oldest 10 events should have been dropped — first remaining is #10
      expect(snap.bodyRejections.recentEvents[0]?.bytesReceived).toBe(10);
    });
  });

  describe('recordTagCount', () => {
    it('buckets into ok / tooMany / tooFew per provider', () => {
      metrics.recordTagCount('groq', 5);
      metrics.recordTagCount('groq', 5);
      metrics.recordTagCount('groq', 8);
      metrics.recordTagCount('cloudflare', 3);

      const snap = metrics.snapshot();
      expect(snap.tagValidation.totalsByProvider['groq']).toEqual({ ok: 2, tooMany: 1, tooFew: 0 });
      expect(snap.tagValidation.totalsByProvider['cloudflare']).toEqual({ ok: 0, tooMany: 0, tooFew: 1 });
    });

    it('keeps providers independent — one provider misbehaving does not affect another', () => {
      metrics.recordTagCount('cloudflare', 2);
      metrics.recordTagCount('cloudflare', 3);
      metrics.recordTagCount('groq', 5);

      const snap = metrics.snapshot();
      expect(snap.tagValidation.totalsByProvider['groq']).toEqual({ ok: 1, tooMany: 0, tooFew: 0 });
      expect(snap.tagValidation.totalsByProvider['cloudflare']?.tooFew).toBe(2);
    });
  });

  describe('recordQueuePersist', () => {
    it('tracks last success and last failure timestamps separately', () => {
      metrics.recordQueuePersist(true, 3);
      metrics.recordQueuePersist(false, 3, 'ENOSPC: no space left on device');
      metrics.recordQueuePersist(true, 4);

      const snap = metrics.snapshot();
      expect(snap.queuePersistence.totals).toEqual({ success: 2, failure: 1 });
      expect(snap.queuePersistence.lastFailureAt).not.toBeNull();
      expect(snap.queuePersistence.lastSuccessAt).not.toBeNull();
      expect(snap.queuePersistence.recentEvents.at(-1)?.ok).toBe(true);
      expect(snap.queuePersistence.recentEvents.find(e => !e.ok)?.error).toContain('ENOSPC');
    });
  });

  it('reset() clears every counter and event list', () => {
    metrics.recordBodyRejection('too_large');
    metrics.recordTagCount('groq', 5);
    metrics.recordQueuePersist(true, 1);

    metrics.reset();

    const snap = metrics.snapshot();
    expect(snap.bodyRejections.totals.too_large).toBe(0);
    expect(snap.bodyRejections.recentEvents).toHaveLength(0);
    expect(snap.tagValidation.totalsByProvider).toEqual({});
    expect(snap.queuePersistence.totals).toEqual({ success: 0, failure: 0 });
    expect(snap.queuePersistence.lastSuccessAt).toBeNull();
  });
});
