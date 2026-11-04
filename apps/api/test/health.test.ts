import { createDb } from "@app/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createLogger } from "../src/infra/logger";

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let database: ReturnType<typeof createDb>;
let redis: Redis;
let deadRedis: Redis;

const logger = createLogger("silent");
const running = { isShuttingDown: () => false };

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
});

afterAll(async () => {
  redis.disconnect();
  deadRedis.disconnect();
  await database.close();
  await Promise.all([postgres.stop(), redisContainer.stop()]);
});

describe("GET /health", () => {
  it("says the process is alive, even when dependencies are down", async () => {
    const app = createApp({ logger, pool: database.pool, redis: deadRedis, lifecycle: running });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /ready", () => {
  it("is ready when PostgreSQL and Redis both answer", async () => {
    const app = createApp({ logger, pool: database.pool, redis, lifecycle: running });
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { database: "up", redis: "up" } });
  });

  it("is not ready, and names the broken part, when Redis is down", async () => {
    const app = createApp({ logger, pool: database.pool, redis: deadRedis, lifecycle: running });
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("NOT_READY");
    expect(res.body.details.checks).toEqual({ database: "up", redis: "down" });
  });

  it("is not ready, and names the broken part, when PostgreSQL is down", async () => {
    const brokenPool = { query: () => Promise.reject(new Error("connection refused")) };
    const app = createApp({ logger, pool: brokenPool, redis, lifecycle: running });
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.details.checks).toEqual({ database: "down", redis: "up" });
  });

  it("is not ready while shutting down, so no new traffic is sent", async () => {
    const app = createApp({ logger, pool: database.pool, redis, lifecycle: { isShuttingDown: () => true } });
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.headers["connection"]).toBe("close");
  });
});

describe("OpenAPI", () => {
  const app = () => createApp({ logger, pool: database.pool, redis, lifecycle: running });

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
