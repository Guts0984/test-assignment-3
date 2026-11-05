import { createDb } from "@app/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { CATALOG_GENERATION } from "@app/shared";
import { createCache, type Cache, type Generation } from "../src/infra/cache/two-level-cache";
import { createSeatsHub, type SeatsHub } from "../src/infra/seats-hub";
import { createSeatsNotifier, type SeatsNotifier } from "../src/infra/seats-notifier";
import { fastCacheTimings, TEST_INTERNAL_SECRET } from "./helpers/stack";
import { createLogger } from "../src/infra/logger";

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let database: ReturnType<typeof createDb>;
let redis: Redis;
let deadRedis: Redis;
let cache: Cache;
let catalog: Generation;
let notifier: SeatsNotifier;
let hub: SeatsHub;

const logger = createLogger("silent");
const running = { isShuttingDown: () => false };
const config = {
  sessionTtlSeconds: 60,
  cookieSecure: false,
  cache: fastCacheTimings,
  bookingHoldSeconds: 600,
  internalSecret: TEST_INTERNAL_SECRET,
  sseHeartbeatMs: 15_000,
  rateLimit: {
    general: { max: 100_000, windowSeconds: 60 },
    loginPerIp: { max: 100_000, windowSeconds: 900 },
    loginPerEmail: { max: 100_000, windowSeconds: 900 },
  },
};

beforeAll(async () => {
  [postgres, redisContainer] = await Promise.all([
    new PostgreSqlContainer("postgres:16-alpine").start(),
    new RedisContainer("redis:7-alpine").start(),
  ]);
  database = createDb(postgres.getConnectionUri(), { max: 2 });
  redis = new Redis(redisContainer.getConnectionUrl());
  // Nothing listens on this port: stands in for a Redis that is down.
  deadRedis = new Redis("redis://127.0.0.1:1", { maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
  deadRedis.on("error", () => undefined);
  cache = await createCache({ redis, subscriber: redis.duplicate(), logger, l1MaxEntries: 10 });
  catalog = await cache.generation(CATALOG_GENERATION);
  notifier = createSeatsNotifier({ db: database.db, redis, cache, logger });
  hub = await createSeatsHub({ subscriber: redis.duplicate(), cache, logger });
});

afterAll(async () => {
  await hub.stop();
  await notifier.close();
  await cache.close();
  redis.disconnect();
  deadRedis.disconnect();
  await database.close();
  await Promise.all([postgres.stop(), redisContainer.stop()]);
});

describe("GET /health", () => {
  it("says the process is alive, even when dependencies are down", async () => {
    const app = createApp({ logger, db: database.db, pool: database.pool, redis: deadRedis, lifecycle: running, cache, catalog, notifier, hub, config });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /ready", () => {
  it("is ready when PostgreSQL and Redis both answer", async () => {
    const app = createApp({ logger, db: database.db, pool: database.pool, redis, lifecycle: running, cache, catalog, notifier, hub, config });
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { database: "up", redis: "up" } });
  });

  it("is not ready, and names the broken part, when Redis is down", async () => {
    const app = createApp({ logger, db: database.db, pool: database.pool, redis: deadRedis, lifecycle: running, cache, catalog, notifier, hub, config });
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("NOT_READY");
    expect(res.body.details.checks).toEqual({ database: "up", redis: "down" });
  });

  it("is not ready, and names the broken part, when PostgreSQL is down", async () => {
    const brokenPool = { query: () => Promise.reject(new Error("connection refused")) };
    const app = createApp({ logger, db: database.db, pool: brokenPool, redis, lifecycle: running, cache, catalog, notifier, hub, config });
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.details.checks).toEqual({ database: "down", redis: "up" });
  });

  it("is not ready while shutting down, so no new traffic is sent", async () => {
    const app = createApp({ logger, db: database.db, pool: database.pool, redis, lifecycle: { isShuttingDown: () => true }, cache, catalog, notifier, hub, config });
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.headers["connection"]).toBe("close");
  });
});

describe("OpenAPI", () => {
  const app = () => createApp({ logger, db: database.db, pool: database.pool, redis, lifecycle: running, cache, catalog, notifier, hub, config });

  it("describes the endpoints from the same schemas", async () => {
    const res = await request(app()).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(Object.keys(res.body.paths)).toEqual(expect.arrayContaining(["/health", "/ready"]));
    const notReady = res.body.paths["/ready"].get.responses["503"];
    expect(notReady.content["application/json"].schema.properties).toHaveProperty("code");
  });

  it("serves the interactive docs at /docs", async () => {
    const res = await request(app()).get("/docs/");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/swagger/i);
  });
});
