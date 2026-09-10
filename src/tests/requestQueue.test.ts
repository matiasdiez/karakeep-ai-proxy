import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { RequestQueue } from '../queue/requestQueue.js';
import { QueuedRequest } from '../providers/types.js';
import { metrics } from '../metrics.js';

function makeItem(id: string): QueuedRequest {
  return {
    id,
    timestamp: Date.now(),
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ model: 'x' })).toString('base64'),
    retries: 0,
  };
}

describe('RequestQueue', () => {
  let tmpDir: string;
  let persistPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-queue-test-'));
    persistPath = path.join(tmpDir, 'queue.json');
    metrics.reset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists enqueued items to disk and reloads them on construction', () => {
    const q1 = new RequestQueue(persistPath);
    q1.enqueue(makeItem('a'));
    q1.enqueue(makeItem('b'));

    expect(fs.existsSync(persistPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
    expect(onDisk.map((i: QueuedRequest) => i.id)).toEqual(['a', 'b']);

    // Simulate a restart: a fresh instance pointed at the same path should
    // pick up the persisted items.
    const q2 = new RequestQueue(persistPath);
    expect(q2.size()).toBe(2);
    expect(q2.peek()?.id).toBe('a');
  });

  it('never leaves a .tmp file behind after a successful persist', () => {
    const q = new RequestQueue(persistPath);
    q.enqueue(makeItem('a'));

    const leftoverTmp = fs.readdirSync(tmpDir).filter(f => f.includes('.tmp-'));
    expect(leftoverTmp).toEqual([]);
  });

  it('does not touch disk at all when persistPath is null', () => {
    const q = new RequestQueue(null);
    q.enqueue(makeItem('a'));
    expect(q.size()).toBe(1);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('records a successful metrics event on every persist', () => {
    const q = new RequestQueue(persistPath);
    q.enqueue(makeItem('a'));
    q.dequeue();

    const snap = metrics.snapshot();
    expect(snap.queuePersistence.totals.success).toBe(2); // enqueue + dequeue
    expect(snap.queuePersistence.totals.failure).toBe(0);
    expect(snap.queuePersistence.lastSuccessAt).not.toBeNull();
  });

  it('records a failure metrics event when the persist path is not writable', () => {
    // Point at a path whose parent directory can't be created (a file, not a dir,
    // sits where a directory is expected) to force writeFileSync/mkdirSync to throw.
    const blockerFile = path.join(tmpDir, 'not-a-directory');
    fs.writeFileSync(blockerFile, 'x');
    const badPath = path.join(blockerFile, 'queue.json');

    const q = new RequestQueue(badPath);
    q.enqueue(makeItem('a'));

    const snap = metrics.snapshot();
    expect(snap.queuePersistence.totals.failure).toBeGreaterThan(0);
    expect(snap.queuePersistence.lastFailureAt).not.toBeNull();
  });

  it('requeueFront puts the item back at the head of the queue', () => {
    const q = new RequestQueue(persistPath);
    q.enqueue(makeItem('a'));
    q.enqueue(makeItem('b'));
    q.requeueFront(makeItem('c'));

    expect(q.peek()?.id).toBe('c');
    expect(q.size()).toBe(3);
  });

  it('starts empty and logs a warning when the persisted file is corrupt JSON', () => {
    fs.writeFileSync(persistPath, '{ not valid json');
    const q = new RequestQueue(persistPath);
    expect(q.size()).toBe(0);
    expect(q.isEmpty()).toBe(true);
  });
});
