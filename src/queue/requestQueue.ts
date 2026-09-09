import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger.js';
import { QueuedRequest } from '../providers/types.js';

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

  private persist(): void {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(this.items, null, 2), 'utf8');
    } catch (err) {
      logger.error('Failed to persist queue', err);
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
