import { createDb } from "@app/db";
import { createApp } from "./app";
import { loadEnv } from "./infra/config/env";
import { createLifecycle } from "./infra/lifecycle";
import { createLogger } from "./infra/logger";
import { createRedis } from "./infra/redis";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const { pool, close: closeDb } = createDb(env.DATABASE_URL, { max: env.DB_POOL_MAX });
  const { redis, close: closeRedis } = createRedis(env.REDIS_URL, logger);
  const lifecycle = createLifecycle({ logger, timeoutMs: env.SHUTDOWN_TIMEOUT_MS });

  const app = createApp({ logger, pool, redis, lifecycle });
  const server = app.listen(env.API_PORT, () => {
    logger.info({ port: env.API_PORT }, "api listening");
  });

  const stop = (signal: string) => {
    logger.info({ signal }, "signal received");
    lifecycle
      .shutdown(server, async () => {
        await closeRedis();
        await closeDb();
      })
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "shutdown failed");
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("api failed to start:", error);
  process.exit(1);
});
