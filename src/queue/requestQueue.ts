import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger.js';
import { QueuedRequest } from '../providers/types.js';
import { metrics } from '../metrics.js';

const logger = createLogger('RequestQueue');

/**
 * In-memory FIFO queue with optional persistence to a JSON file.
 *
 * Persistence format: a JSON array of QueuedRequest objects.
 * The file is re-written on every enqueue/dequeue so it survives crashes,
 * at the cost of O(n) writes. For 14,000 bookmarks this is acceptable.
 */
export class RequestQueue {
  private readonly persistPath: string | null;
  private items: QueuedRequest[] = [];

  constructor(persistPath: string | null) {
    this.persistPath = persistPath;
    this.load();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  enqueue(req: QueuedRequest): void {
    this.items.push(req);
    logger.info(`Enqueued request ${req.id} (queue size: ${this.items.length})`);
    this.persist();
  }

  dequeue(): QueuedRequest | null {
    const item = this.items.shift() ?? null;
    if (item) {
      logger.debug(`Dequeued request ${item.id} (queue size: ${this.items.length})`);
      this.persist();
    }
    return item;
  }

  peek(): QueuedRequest | null {
    return this.items[0] ?? null;
  }

  size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Re-queue a request at the front (after a failed retry attempt).
   */
  requeueFront(req: QueuedRequest): void {
    this.items.unshift(req);
    this.persist();
  }

  /**
   * Force-flush to disk (called during graceful shutdown).
   */
  flush(): void {
    this.persist();
    logger.info(`Queue flushed to disk (${this.items.length} items)`);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Writes the queue to disk atomically: write to a temp file in the same
   * directory, then rename over the real path. `rename` is atomic on POSIX
   * filesystems, so a crash mid-write leaves either the old file or the new
   * one intact — never a truncated/corrupt one.
   */
  private persist(): void {
    if (!this.persistPath) return;
    const tmpPath = `${this.persistPath}.tmp-${process.pid}`;
    try {
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(this.items, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.persistPath);
      metrics.recordQueuePersist(true, this.items.length);
    } catch (err) {
      logger.error('Failed to persist queue', err);
      metrics.recordQueuePersist(false, this.items.length, err instanceof Error ? err.message : String(err));
      try { fs.unlinkSync(tmpPath); } catch { /* tmp file may not have been created */ }
    }
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        this.items = parsed as QueuedRequest[];
        logger.info(`Loaded ${this.items.length} queued requests from disk`);
      }
    } catch (err) {
      logger.warn('Failed to load persisted queue — starting empty', err);
      this.items = [];
    }
  }
}
