import { createDb } from "@app/db";
import { CATALOG_GENERATION, OUTBOX_WAKE_CHANNEL } from "@app/shared";
import { createApp } from "./app";
import { createCache } from "./infra/cache/two-level-cache";
import { loadEnv } from "./infra/config/env";
import { createLifecycle } from "./infra/lifecycle";
import { createLogger } from "./infra/logger";
import { createSeatsHub } from "./infra/seats-hub";
import { createSeatsNotifier } from "./infra/seats-notifier";
import { createRedis } from "./infra/redis";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const { db, pool, close: closeDb } = createDb(env.DATABASE_URL, { max: env.DB_POOL_MAX });
  const { redis, close: closeRedis } = createRedis(env.REDIS_URL, logger);
  const cache = await createCache({
    redis,
    subscriber: redis.duplicate(),
    logger,
    l1MaxEntries: env.CACHE_L1_MAX_ENTRIES,
  });
  const catalog = await cache.generation(CATALOG_GENERATION);
  const notifier = createSeatsNotifier({ db, redis, cache, logger });
  const hub = await createSeatsHub({ subscriber: redis.duplicate(), cache, logger });
  const lifecycle = createLifecycle({ logger, timeoutMs: env.SHUTDOWN_TIMEOUT_MS });
  // Open live-seat streams never end by themselves, so shutdown has to close them.
  lifecycle.onShutdown(() => hub.closeAll());

  const app = createApp({
    logger,
    db,
    pool,
    redis,
    lifecycle,
    cache,
    catalog,
    notifier,
    hub,
    // Tell the worker straight away that there is something new in the outbox. If this fails, the
    // worker finds the note anyway at its next regular look.
    onEventUpdated: async () => {
      await redis.publish(OUTBOX_WAKE_CHANNEL, "1").catch((error: unknown) => {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, "could not wake the worker");
      });
    },
    config: {
      sessionTtlSeconds: env.SESSION_TTL_SECONDS,
      cookieSecure: env.COOKIE_SECURE,
      bookingHoldSeconds: env.BOOKING_HOLD_SECONDS,
      internalSecret: env.INTERNAL_API_SECRET,
      sseHeartbeatMs: env.SSE_HEARTBEAT_MS,
      rateLimit: {
        general: { max: env.RATE_LIMIT_MAX, windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS },
        loginPerIp: { max: env.LOGIN_LIMIT_PER_IP, windowSeconds: env.LOGIN_LIMIT_WINDOW_SECONDS },
        loginPerEmail: { max: env.LOGIN_LIMIT_PER_EMAIL, windowSeconds: env.LOGIN_LIMIT_WINDOW_SECONDS },
      },
      cache: {
        l1TtlMs: env.CACHE_L1_TTL_MS,
        l2TtlMs: env.CACHE_L2_TTL_MS,
        negativeTtlMs: env.CACHE_NEGATIVE_TTL_MS,
        availabilityTtlMs: env.AVAILABILITY_TTL_MS,
      },
    },
  });
  const server = app.listen(env.API_PORT, () => {
    logger.info({ port: env.API_PORT }, "api listening");
  });

  const stop = (signal: string) => {
    logger.info({ signal }, "signal received");
    lifecycle
      .shutdown(server, async () => {
        await hub.stop();
        await notifier.close();
        await cache.close();
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
