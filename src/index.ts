import express from 'express';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { ProviderManager } from './providers/providerManager.js';
import { RequestQueue } from './queue/requestQueue.js';
import { createProxyHandler, startQueueDrainer, startRecoveryChecker } from './proxy/handler.js';
import { createStatusRouter } from './routes/status.js';

const logger = createLogger('Main');

async function main() {
  const config = loadConfig();
  logger.info('Karakeep AI Proxy starting', {
    port: config.port,
    activeHours: `${config.activeHoursStart}–${config.activeHoursEnd} (${config.timezone})`,
    groqModel: config.groq.model,
    geminiModel: config.gemini.model,
    ollamaModel: config.ollama.model,
  });

  const providerManager = new ProviderManager(config);
  const queue = new RequestQueue(config.queuePersistPath);

  const app = express();

  // ── Disable Express's default body parsing — we want raw buffers ───────────
  // (The proxy handler reads the stream directly)
  app.disable('x-powered-by');

  // ── Status / health routes (no auth required) ──────────────────────────────
  app.use(createStatusRouter(providerManager, queue));

  // ── Wildcard proxy route ────────────────────────────────────────────────────
  // app.use() como catch-all: captura todo lo que no fue manejado por las rutas
  // de status/health arriba. Compatible con Express 4.x (app.all('*') y el
  // wildcard /*splat son sintaxis de Express 5 y no funcionan en Express 4).
  const proxyHandler = createProxyHandler(
    providerManager,
    queue,
    config.waitMaxMs,
    config.maxBodyBytes,
    config.requestReadTimeoutMs,
  );
  app.use(proxyHandler);

  // Nota: el 404 catch-all ya no es necesario porque proxyHandler responde
  // a todo. Si el path no es /v1/*, forwardRequest lo enviará al proveedor
  // tal cual y este devolverá su propio error.

  // ── Start background workers ───────────────────────────────────────────────
  const stopDrainer = startQueueDrainer(providerManager, queue);
  const stopRecovery = startRecoveryChecker(providerManager);

  // ── Start server ───────────────────────────────────────────────────────────
  const server = app.listen(config.port, () => {
    logger.info(`Listening on port ${config.port}`);
    logger.info(`  → Set OPENAI_BASE_URL=http://ai-proxy:${config.port}/v1 in Karakeep`);
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  function shutdown(signal: string) {
    logger.info(`Received ${signal} — shutting down gracefully`);

    server.close(() => {
      stopDrainer();
      stopRecovery();
      queue.flush();
      logger.info('Shutdown complete');
      process.exit(0);
    });

    // Force exit after 30 s if server doesn't close
    setTimeout(() => {
      logger.warn('Forced shutdown after 30s timeout');
      queue.flush();
      process.exit(1);
    }, 30_000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
