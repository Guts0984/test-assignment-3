import { randomUUID } from "node:crypto";
import { createDb, type Database, type DbPool } from "@app/db";
import { CATALOG_GENERATION } from "@app/shared";
import type { Express } from "express";
import { Redis } from "ioredis";
import pg from "pg";
import { inject } from "vitest";
import { createApp, type AppConfig } from "../../src/app";
import { createCache, type Cache, type CacheOptions, type Generation } from "../../src/infra/cache/two-level-cache";
import { createLogger } from "../../src/infra/logger";
import { createSeatsHub, type SeatsHub } from "../../src/infra/seats-hub";
import { createSeatsNotifier, type SeatsNotifier } from "../../src/infra/seats-notifier";

/** Lets a test slow down lock handling, or give the cache a Redis that can be broken. */
export type InstanceCacheOptions = Partial<Pick<CacheOptions, "lockWaitMs" | "lockTtlMs" | "pollMs" | "l1MaxEntries">> & {
  cacheRedis?: CacheOptions["redis"];
  /** Called after an event edit succeeded (the real one wakes the worker). */
  onEventUpdated?: (event: import("@app/shared").EventDto) => Promise<void> | void;
};

export interface Instance {
  app: Express;
  notifier: SeatsNotifier;
  hub: SeatsHub;
  cache: Cache;
  catalog: Generation;
}

export interface Stack {
  app: Express;
  db: Database;
  pool: DbPool;
  redis: Redis;
  catalog: Generation;
  /** Another api instance on the same database and Redis (like api2 next to api1), with its own memory. */
  makeInstance: (overrides?: Partial<AppConfig>, cacheOptions?: InstanceCacheOptions) => Promise<Instance>;
  /** How many SQL statements mentioning `fragment` reached Postgres from now on (until `stop()`). */
  countQueries: (fragment: RegExp) => { count: () => number; stop: () => void };
  close: () => Promise<void>;
}

export const TEST_INTERNAL_SECRET = "test-secret-test-secret-test-secret-1234";

export const fastCacheTimings: AppConfig["cache"] = {
  l1TtlMs: 10_000,
  l2TtlMs: 60_000,
  negativeTtlMs: 15_000,
  availabilityTtlMs: 1000,
};

const defaultConfig: AppConfig = {
  sessionTtlSeconds: 3600,
  cookieSecure: false,
  cache: fastCacheTimings,
  bookingHoldSeconds: 600,
  internalSecret: TEST_INTERNAL_SECRET,
  sseHeartbeatMs: 15_000,
  // Generous, so tests that are not about limits never run into them.
  rateLimit: {
    general: { max: 100_000, windowSeconds: 60 },
    loginPerIp: { max: 100_000, windowSeconds: 900 },
    loginPerEmail: { max: 100_000, windowSeconds: 900 },
  },
};

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * A fresh, migrated, empty database (a copy of the template), the shared Redis (emptied), and an
 * api built on them. Test files run one after another, so they never share data.
 */
export async function startStack(config: Partial<AppConfig> = {}): Promise<Stack> {
  const baseUrl = inject("pgBaseUrl");
  const name = `t_${randomUUID().replaceAll("-", "")}`;

  const admin = new pg.Client({ connectionString: withDatabase(baseUrl, "postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${inject("pgTemplateDb")}`);
  await admin.end();

  const database = createDb(withDatabase(baseUrl, name), { max: 20 });
  const redis = new Redis(inject("redisUrl"));
  await redis.flushall();

  const logger = createLogger("silent");
  const lifecycle = { isShuttingDown: () => false };
  const caches: Cache[] = [];
  const notifiers: SeatsNotifier[] = [];
  const hubs: SeatsHub[] = [];

  const makeInstance = async (
    overrides: Partial<AppConfig> = {},
    { cacheRedis, onEventUpdated, ...cacheOptions }: InstanceCacheOptions = {},
  ): Promise<Instance> => {
    const cache = await createCache({
      redis: cacheRedis ?? redis,
      subscriber: redis.duplicate(),
      logger,
      l1MaxEntries: 500,
      ...cacheOptions,
    });
    caches.push(cache);
    const catalog = await cache.generation(CATALOG_GENERATION);
    const notifier = createSeatsNotifier({ db: database.db, redis, cache, logger });
    notifiers.push(notifier);
    const hub = await createSeatsHub({ subscriber: redis.duplicate(), cache, logger });
    hubs.push(hub);
    const app = createApp({
      logger,
      db: database.db,
      pool: database.pool,
      redis,
      lifecycle,
      cache,
      catalog,
      notifier,
      hub,
      ...(onEventUpdated ? { onEventUpdated } : {}),
      config: { ...defaultConfig, ...config, ...overrides },
    });
    return { app, notifier, hub, cache, catalog };
  };

  const first = await makeInstance();

  return {
    app: first.app,
    db: database.db,
    pool: database.pool,
    redis,
    catalog: first.catalog,
    makeInstance,
    countQueries: (fragment) => {
      let seen = 0;
      const original = database.pool.query.bind(database.pool);
      // Count what reaches Postgres, by watching the pool every query goes through.
      const spy = ((...args: unknown[]) => {
        const first = args[0];
        const text = typeof first === "string" ? first : typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
        if (fragment.test(text)) seen += 1;
        return (original as (...a: unknown[]) => unknown)(...args);
      }) as typeof database.pool.query;
      database.pool.query = spy;
      return {
        count: () => seen,
        stop: () => {
          database.pool.query = original as typeof database.pool.query;
        },
      };
    },
    close: async () => {
      await Promise.all(hubs.map((hub) => hub.stop()));
      await Promise.all(notifiers.map((notifier) => notifier.close()));
      await Promise.all(caches.map((cache) => cache.close()));
      redis.disconnect();
      await database.close();
    },
  };
}
