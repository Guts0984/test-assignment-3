import http from "node:http";
import { createDb } from "@app/db";
import { Redis } from "ioredis";
import { loadEnv } from "./env";
import { createLogger } from "./logger";
import { startWorker } from "./worker";


async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const { db, pool, close: closeDb } = createDb(env.DATABASE_URL, { max: env.DB_POOL_MAX });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
  redis.on("error", (error: Error) => logger.error({ err: error.message }, "redis connection error"));

  const worker = await startWorker({
    db,
    redis,
    subscriber: redis.duplicate(),
    redisUrl: env.REDIS_URL,
    logger,
    settings: {
      expiryIntervalMs: env.EXPIRY_INTERVAL_MS,
      outboxPollMs: env.OUTBOX_POLL_MS,
      revalidate: {
        url: env.WEB_REVALIDATE_URL,
        secret: env.INTERNAL_API_SECRET,
        attempts: env.REVALIDATE_ATTEMPTS,
        backoffMs: env.REVALIDATE_BACKOFF_MS,
        timeoutMs: env.REVALIDATE_TIMEOUT_MS,
      },
    },
  });

  // For Docker's health check: answers 200 while the database and Redis both answer.
  const health = http.createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    Promise.all([pool.query("SELECT 1"), redis.ping()]).then(
      () => res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}'),
      () => res.writeHead(503, { "content-type": "application/json" }).end('{"status":"down"}'),
    );
  });
  health.listen(env.HEALTH_PORT);
  logger.info({ healthPort: env.HEALTH_PORT }, "worker started");

  const stop = (signal: string) => {
    logger.info({ signal }, "signal received, finishing the current job");
    const forced = setTimeout(() => {
      logger.error("shutdown took too long");
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forced.unref();
    health.close();
    worker
      .stop()
      .then(async () => {
        redis.disconnect();
        await closeDb();
        logger.info("worker stopped");
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error instanceof Error ? error.message : String(error) }, "shutdown failed");
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("worker failed to start:", error);
  process.exit(1);
});
