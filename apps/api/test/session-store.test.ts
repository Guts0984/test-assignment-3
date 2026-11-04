import { randomUUID } from "node:crypto";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionStore, sessionKey } from "../src/modules/auth/session-store";

let container: StartedRedisContainer;
let redis: Redis;
let secondConnection: Redis;

beforeAll(async () => {
  container = await new RedisContainer("redis:7-alpine").start();
  redis = new Redis(container.getConnectionUrl());
  secondConnection = new Redis(container.getConnectionUrl());
});
afterAll(async () => {
  redis.disconnect();
  secondConnection.disconnect();
  await container.stop();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await redis.flushall();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const store = (ttlSeconds = 60, connection: Redis = redis) => createSessionStore({ redis: connection, ttlSeconds });

describe("create and find", () => {
  it("finds the user of a session it created", async () => {
    const userId = randomUUID();
    const { sessionId } = await store().create(userId);
    expect(await store().find(sessionId)).toEqual({ userId });
  });

  it("keeps different users apart", async () => {
    const [alice, bob] = [randomUUID(), randomUUID()];
    const [a, b] = await Promise.all([store().create(alice), store().create(bob)]);
    expect(await store().find(a.sessionId)).toEqual({ userId: alice });
    expect(await store().find(b.sessionId)).toEqual({ userId: bob });
  });

  it("makes ids of 43 URL-safe characters that never repeat", async () => {
    const userId = randomUUID();
    const ids = await Promise.all(Array.from({ length: 500 }, () => store().create(userId)));
    const unique = new Set(ids.map((s) => s.sessionId));
    expect(unique.size).toBe(500);
    expect([...unique].every((id) => /^[A-Za-z0-9_-]{43}$/.test(id))).toBe(true);
  });

  it("does not find an id that was never created", async () => {
    expect(await store().find("A".repeat(43))).toBeUndefined();
  });

  it("is shared between api instances: another connection sees the same session", async () => {
    const userId = randomUUID();
    const { sessionId } = await store(60, redis).create(userId);
    expect(await store(60, secondConnection).find(sessionId)).toEqual({ userId });
  });
});

describe("what is stored in Redis", () => {
  it("never stores the session id itself, only a hash of it", async () => {
    const { sessionId } = await store().create(randomUUID());
    const keys = await redis.keys("*");
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(sessionKey(sessionId));
    expect(keys.join()).not.toContain(sessionId);
    const value = (await redis.get(keys[0] ?? "")) ?? "";
    expect(value).not.toContain(sessionId);
  });

  it("stores no password or email, only the user id", async () => {
    const userId = randomUUID();
    const { sessionId } = await store().create(userId);
    expect(JSON.parse((await redis.get(sessionKey(sessionId))) ?? "")).toEqual({ userId });
  });
});

describe("expiry", () => {
  it("sets the lifetime on the Redis key", async () => {
    const { sessionId } = await store(300).create(randomUUID());
    const ttl = await redis.ttl(sessionKey(sessionId));
    expect(ttl).toBeGreaterThan(295);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it("really disappears after its lifetime", async () => {
    const { sessionId } = await store(1).create(randomUUID());
    // Not read with find() before waiting: find() itself renews the lifetime.
    expect(await redis.exists(sessionKey(sessionId))).toBe(1);
    await sleep(1600);
    expect(await redis.exists(sessionKey(sessionId))).toBe(0);
    expect(await store(1).find(sessionId)).toBeUndefined();
  });

  it("is renewed each time it is used, so an active user stays logged in", async () => {
    const sessions = store(100);
    const { sessionId } = await sessions.create(randomUUID());
    await redis.expire(sessionKey(sessionId), 10); // pretend almost all of the time has passed
    expect(await redis.ttl(sessionKey(sessionId))).toBeLessThanOrEqual(10);

    await sessions.find(sessionId);
    expect(await redis.ttl(sessionKey(sessionId))).toBeGreaterThan(95);
  });

  it("is not renewed by ids that do not exist (no empty keys are created)", async () => {
    await store().find("B".repeat(43));
    expect(await redis.keys("*")).toEqual([]);
  });

  it("refuses a lifetime that Redis would reject", () => {
    expect(() => store(0)).toThrow(/at least 1/);
    expect(() => store(-5)).toThrow();
    expect(() => store(1.5)).toThrow();
  });
});

describe("destroy", () => {
  it("ends the session at once", async () => {
    const { sessionId } = await store().create(randomUUID());
    await store().destroy(sessionId);
    expect(await store().find(sessionId)).toBeUndefined();
    expect(await redis.keys("*")).toEqual([]);
  });

  it("ends only that session; the same user's other session keeps working", async () => {
    const userId = randomUUID();
    const first = await store().create(userId);
    const second = await store().create(userId);
    await store().destroy(first.sessionId);
    expect(await store().find(first.sessionId)).toBeUndefined();
    expect(await store().find(second.sessionId)).toEqual({ userId });
  });

  it("does not fail for an unknown or malformed id", async () => {
    await expect(store().destroy("A".repeat(43))).resolves.toBeUndefined();
    await expect(store().destroy("not an id")).resolves.toBeUndefined();
  });

  it("works from another connection (log out on one instance, dead on the other)", async () => {
    const { sessionId } = await store(60, redis).create(randomUUID());
    await store(60, secondConnection).destroy(sessionId);
    expect(await store(60, redis).find(sessionId)).toBeUndefined();
  });
});

describe("hostile or damaged input", () => {
  it.each([
    ["empty", ""],
    ["too short", "abc"],
    ["too long", "A".repeat(44)],
    ["wrong characters", `${"A".repeat(42)}!`],
    ["a Redis pattern", "*"],
    ["a key prefix", "sess:abc"],
    ["spaces", `${"A".repeat(21)} ${"A".repeat(21)}`],
    ["a newline", `${"A".repeat(42)}\n`],
  ])("does not even ask Redis about an id that is %s", async (_name, badId) => {
    const getex = vi.spyOn(redis, "getex");
    const del = vi.spyOn(redis, "del");
    expect(await store().find(badId)).toBeUndefined();
    await store().destroy(badId);
    expect(getex).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "garbage{"],
    ["a user id that is not an id", JSON.stringify({ userId: "admin" })],
    ["a number as user id", JSON.stringify({ userId: 5 })],
    ["no user id", JSON.stringify({})],
    ["null", "null"],
  ])("treats a damaged record (%s) as no session, without crashing", async (_name, value) => {
    const sessionId = "C".repeat(43);
    await redis.set(sessionKey(sessionId), value, "EX", 60);
    expect(await store().find(sessionId)).toBeUndefined();
  });
});
