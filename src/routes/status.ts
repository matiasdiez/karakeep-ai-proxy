import { Router } from 'express';
import { ProviderManager } from '../providers/providerManager.js';
import { RequestQueue } from '../queue/requestQueue.js';

/**
 * GET /status — returns current proxy state as JSON.
 */
export function createStatusRouter(
  providerManager: ProviderManager,
  queue: RequestQueue,
): Router {
  const router = Router();

  router.get('/status', (_req, res) => {
    const stats = providerManager.getStats();
    res.json({
      ...stats,
      queueSize: queue.size(),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  return router;
}
