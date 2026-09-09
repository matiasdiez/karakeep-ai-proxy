import { Request, Response } from 'express';
import crypto from 'crypto';
import { createLogger } from '../logger.js';
import { ProviderManager, ActiveProvider } from '../providers/providerManager.js';
import { ProviderName, QueuedRequest } from '../providers/types.js';
import { RequestQueue } from '../queue/requestQueue.js';
import { forwardRequest, estimateTokens } from './forwardRequest.js';
import { enrichTaggingRequest, sanitizeTaggingResponse } from './tagEnricher.js';

const logger = createLogger('Handler');

/** Maximum number of provider attempts per incoming request before queuing */
const MAX_PROVIDER_ATTEMPTS = 2;

/**
 * Main proxy handler.
 *
 * Intercepts all requests from Karakeep to /v1/* and:
 * 1. Checks if we're in active hours and have a provider with quota.
 * 2. Forwards to the best available provider.
 * 3. On 429 → failovers to the next provider.
 * 4. On no available provider → enqueues the request.
 *
 * The queue drainer (started in index.ts) will retry queued requests
 * when a provider becomes available again.
 */
export function createProxyHandler(
  providerManager: ProviderManager,
  queue: RequestQueue,
  waitMaxMs = 20_000,
) {
  return async function handler(req: Request, res: Response): Promise<void> {
    // Collect body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    const rawBodyBuffer = Buffer.concat(chunks);
    const bodyBuffer = enrichTaggingRequest(rawBodyBuffer);

    // Sanitize incoming headers into a plain Record<string, string>
    const incomingHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        incomingHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    }

    const tokenEstimate = estimateTokens(bodyBuffer);

    // ── Try up to MAX_PROVIDER_ATTEMPTS providers ────────────────────────────
    let attempts = 0;
    let lastStatus = 503;

    while (attempts < MAX_PROVIDER_ATTEMPTS) {
      const provider = providerManager.getActiveProvider(tokenEstimate);

      if (!provider) {
        // No provider available → enqueue
        break;
      }

      attempts++;
      logger.info(`Attempt ${attempts}/${MAX_PROVIDER_ATTEMPTS} via ${provider.name}`);

      let result: Awaited<ReturnType<typeof forwardRequest>>;
      try {
        result = await forwardRequest(
          req.method,
          req.path,
          incomingHeaders,
          bodyBuffer,
          provider,
        );
      } catch (err) {
        logger.error(`Network error forwarding to ${provider.name}`, err);
        lastStatus = 502;
        // Don't mark as exhausted on network errors — could be transient
        break;
      }

      if (result.rateLimited) {
        // Hard 429 → mark exhausted (daily if detected), try next provider
        providerManager.markExhausted(provider.name as ProviderName, result.isDaily);
        lastStatus = 429;
        continue;
      }

      // Record usage
      if (result.tokensUsed > 0) {
        providerManager.recordUsage(provider.name as ProviderName, result.tokensUsed);
      }

      // Pass response through to Karakeep
      // Strip hop-by-hop headers
      const hopByHop = new Set([
        'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
        'te', 'trailers', 'transfer-encoding', 'upgrade',
      ]);

      const responseBody = sanitizeTaggingResponse(result.body);

      for (const [key, value] of Object.entries(result.headers)) {
        if (!hopByHop.has(key.toLowerCase()) && key.toLowerCase() !== 'content-length') {
          res.setHeader(key, value);
        }
      }
      res.setHeader('content-length', responseBody.length);

      res.status(result.status).send(responseBody);
      return;
    }

    // ── No provider succeeded → esperar hasta waitMaxMs antes de encolar ──────
    // Si devolvemos 202 inmediatamente, el SDK de OpenAI lo trata como error,
    // BullMQ reintenta al instante y se genera un spin de miles de req/min
    // que satura CPU. En cambio, mantenemos la conexión abierta hasta que:
    //   a) Un proveedor se recupera → procesamos directamente
    //   b) Pasan waitMaxMs (default 20s) sin proveedor → encolamos y devolvemos 202
    //      (20s evita timeout de liteque en Karakeep que corta a los 30s)
    const WAIT_POLL_MS = 2_000;
    const waitStart = Date.now();

    while (Date.now() - waitStart < waitMaxMs) {
      await sleep(WAIT_POLL_MS);
      providerManager.checkRecovery();

      const recoveredProvider = providerManager.getActiveProvider(tokenEstimate);
      if (recoveredProvider) {
        logger.info(`Provider recovered during wait — processing directly (${recoveredProvider.name})`);
        try {
          const result = await forwardRequest(
            req.method,
            req.path,
            incomingHeaders,
            bodyBuffer,
            recoveredProvider,
          );

          if (!result.rateLimited) {
            if (result.tokensUsed > 0) {
              providerManager.recordUsage(recoveredProvider.name as ProviderName, result.tokensUsed);
            }
            const hopByHop = new Set([
              'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
              'te', 'trailers', 'transfer-encoding', 'upgrade',
            ]);
            const responseBody = sanitizeTaggingResponse(result.body);
            for (const [key, value] of Object.entries(result.headers)) {
              if (!hopByHop.has(key.toLowerCase()) && key.toLowerCase() !== 'content-length') {
                res.setHeader(key, value);
              }
            }
            res.setHeader('content-length', responseBody.length);
            res.status(result.status).send(responseBody);
            return;
          }
          // Si de todas formas hay 429, marcamos y seguimos esperando
          providerManager.markExhausted(recoveredProvider.name as ProviderName, result.isDaily);
        } catch (err) {
          logger.error('Error forwarding during recovery wait', err);
        }
      }
    }

    // Después de waitMaxMs sin proveedor → encolar

    const queuedReq: QueuedRequest = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      method: req.method,
      path: req.path,
      headers: incomingHeaders,
      body: bodyBuffer.toString('base64'),
      retries: 0,
    };

    queue.enqueue(queuedReq);

    // Return 202 Accepted so Karakeep does not mark the job as failed.
    // The queue drainer will replay the request and the actual response is lost
    // (Karakeep re-crawls anyway when the worker retries the job).
    // This is a deliberate trade-off: we keep jobs alive in BullMQ at the cost
    // of not returning the actual AI response inline.
    res.status(202).json({
      queued: true,
      queueId: queuedReq.id,
      queueSize: queue.size(),
      message: 'All providers are at capacity. Request queued and will be retried automatically.',
    });

    logger.warn(`Request queued (id=${queuedReq.id}, queueSize=${queue.size()})`);
  };
}

/**
 * Queue drainer — runs in the background and processes queued requests
 * whenever a provider becomes available.
 *
 * Returns a cleanup function that stops the drainer.
 */
export function startQueueDrainer(
  providerManager: ProviderManager,
  queue: RequestQueue,
): () => void {
  let running = true;

  async function drain() {
    while (running) {
      if (queue.isEmpty()) {
        await sleep(5_000);
        continue;
      }

      const provider = providerManager.getActiveProvider();
      if (!provider) {
        // No provider available — wait and check recovery
        providerManager.checkRecovery();
        await sleep(10_000);
        continue;
      }

      const item = queue.dequeue();
      if (!item) continue;

      logger.info(`Draining queued request ${item.id} (retries=${item.retries})`);

      try {
        const bodyBuffer = Buffer.from(item.body, 'base64');
        const result = await forwardRequest(
          item.method,
          item.path,
          item.headers,
          bodyBuffer,
          provider,
        );

        if (result.rateLimited) {
          providerManager.markExhausted(provider.name as ProviderName, result.isDaily);
          // Put back at front
          queue.requeueFront({ ...item, retries: item.retries + 1 });
          await sleep(2_000);
          continue;
        }

        if (result.tokensUsed > 0) {
          providerManager.recordUsage(provider.name as ProviderName, result.tokensUsed);
        }

        logger.info(`Queued request ${item.id} completed (status=${result.status})`);
      } catch (err) {
        logger.error(`Failed to drain queued request ${item.id}`, err);
        // Requeue at front if retries < 5
        if (item.retries < 5) {
          queue.requeueFront({ ...item, retries: item.retries + 1 });
          await sleep(5_000);
        } else {
          logger.warn(`Dropping queued request ${item.id} after ${item.retries} retries`);
        }
      }
    }
  }

  // Start drainer in background (fire-and-forget)
  drain().catch(err => logger.error('Queue drainer crashed', err));

  return () => {
    running = false;
    logger.info('Queue drainer stopping');
  };
}

// ── Recovery checker ─────────────────────────────────────────────────────────

/**
 * Periodically calls checkRecovery() on the provider manager.
 * Returns a cleanup function.
 */
export function startRecoveryChecker(
  providerManager: ProviderManager,
  intervalMs = 30_000,
): () => void {
  const interval = setInterval(() => {
    providerManager.checkRecovery();
  }, intervalMs);

  return () => clearInterval(interval);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
