/**
 * In-memory operational metrics, exposed via GET /status alongside
 * ProviderManager.getStats(). These aren't rate-limiting counters (those live
 * in RateLimiter) — they're signals about proxy *health* that previously only
 * existed as scattered log lines:
 *
 *   - How often incoming requests get rejected for being too large / too slow
 *     to arrive (MAX_BODY_BYTES / REQUEST_READ_TIMEOUT_MS).
 *   - How often a provider's model ignores the "exactly 5 tags" rule that
 *     tagEnricher asks for, broken down per provider — a quality signal for
 *     a specific model, not just "something went wrong somewhere".
 *   - Whether the request queue is actually persisting to disk successfully.
 *
 * Metrics reset when the process restarts — this is not a time-series store,
 * it's a rolling window (totals since start + the last MAX_EVENTS events of
 * each kind) meant to be scraped by an external dashboard on a schedule.
 */

const MAX_EVENTS = 50;

export type BodyRejectionReason = 'too_large' | 'read_timeout';

export interface BodyRejectionEvent {
  timestamp: number; // epoch ms
  reason: BodyRejectionReason;
  bytesReceived?: number;
  limitBytes?: number;
  elapsedMs?: number;
  limitMs?: number;
}

export interface TagCountEvent {
  timestamp: number;
  provider: string;
  tagCount: number;
  expected: number;
}

export interface TagProviderTotals {
  ok: number;
  tooMany: number;
  tooFew: number;
}

export interface QueuePersistEvent {
  timestamp: number;
  ok: boolean;
  itemCount: number;
  error?: string;
}

function pushCapped<T>(arr: T[], item: T): void {
  arr.push(item);
  if (arr.length > MAX_EVENTS) arr.shift();
}

class Metrics {
  private bodyRejectionTotals: Record<BodyRejectionReason, number> = {
    too_large: 0,
    read_timeout: 0,
  };
  private bodyRejectionEvents: BodyRejectionEvent[] = [];

  private tagTotalsByProvider: Record<string, TagProviderTotals> = {};
  private tagEvents: TagCountEvent[] = [];

  private queuePersistTotals = { success: 0, failure: 0 };
  private queuePersistEvents: QueuePersistEvent[] = [];

  /** Call when readBody() rejects an incoming request for size or timeout. */
  recordBodyRejection(reason: BodyRejectionReason, detail: Partial<BodyRejectionEvent> = {}): void {
    this.bodyRejectionTotals[reason]++;
    pushCapped(this.bodyRejectionEvents, { timestamp: Date.now(), reason, ...detail });
  }

  /**
   * Call once per tagging response processed by sanitizeTaggingResponse(),
   * with the tag count it found (before or after truncation — pass the count
   * actually returned by the model, pre-truncation, for an accurate quality
   * signal per provider).
   */
  recordTagCount(provider: string, tagCount: number, expected = 5): void {
    const bucket = this.tagTotalsByProvider[provider] ?? (this.tagTotalsByProvider[provider] = { ok: 0, tooMany: 0, tooFew: 0 });
    if (tagCount === expected) bucket.ok++;
    else if (tagCount > expected) bucket.tooMany++;
    else bucket.tooFew++;
    pushCapped(this.tagEvents, { timestamp: Date.now(), provider, tagCount, expected });
  }

  /** Call after every RequestQueue.persist() attempt, success or failure. */
  recordQueuePersist(ok: boolean, itemCount: number, error?: string): void {
    if (ok) this.queuePersistTotals.success++;
    else this.queuePersistTotals.failure++;
    pushCapped(this.queuePersistEvents, { timestamp: Date.now(), ok, itemCount, error });
  }

  /** Full snapshot for GET /status. Safe to call frequently — just reads in-memory state. */
  snapshot() {
    const lastPersist = [...this.queuePersistEvents].reverse();
    return {
      bodyRejections: {
        totals: { ...this.bodyRejectionTotals },
        recentEvents: [...this.bodyRejectionEvents],
      },
      tagValidation: {
        totalsByProvider: Object.fromEntries(
          Object.entries(this.tagTotalsByProvider).map(([k, v]) => [k, { ...v }]),
        ),
        recentEvents: [...this.tagEvents],
      },
      queuePersistence: {
        totals: { ...this.queuePersistTotals },
        lastSuccessAt: lastPersist.find(e => e.ok)?.timestamp ?? null,
        lastFailureAt: lastPersist.find(e => !e.ok)?.timestamp ?? null,
        recentEvents: [...this.queuePersistEvents],
      },
    };
  }

  /** Test-only: clears all counters and events. */
  reset(): void {
    this.bodyRejectionTotals = { too_large: 0, read_timeout: 0 };
    this.bodyRejectionEvents = [];
    this.tagTotalsByProvider = {};
    this.tagEvents = [];
    this.queuePersistTotals = { success: 0, failure: 0 };
    this.queuePersistEvents = [];
  }
}

/** Process-wide singleton — one proxy process, one set of counters. */
export const metrics = new Metrics();
export type MetricsSnapshot = ReturnType<Metrics['snapshot']>;
