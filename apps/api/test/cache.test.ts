import { randomUUID } from "node:crypto";
import { events, outbox } from "@app/db";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createCache, type CachePolicy } from "../src/infra/cache/two-level-cache";
import { createLogger } from "../src/infra/logger";
import { startStack, type Instance, type Stack } from "./helpers/stack";

let stack: Stack;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack.close();
});
beforeEach(async () => {
  await stack.db.delete(outbox);
  await stack.db.delete(events);
});

async function addEvent(overrides: Partial<typeof events.$inferInsert> = {}): Promise<number> {
  const [row] = await stack.db
    .insert(events)
    .values({
      title: "Cached concert",
      description: "d",
      city: "Cacheville",
      venue: "v",
      startsAt: new Date("2031-05-05T10:00:00Z"),
      capacity: 50,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("no event");
  return row.id;
}

describe("level 1: the same instance", () => {
  it("serves the second request without asking the database", async () => {
    const id = await addEvent();
    const counter = stack.countQueries(/from "events"/i);
    const first = await request(stack.app).get(`/events/${id}`);
    const second = await request(stack.app).get(`/events/${id}`);
    counter.stop();
    expect(second.body).toEqual(first.body);
    expect(counter.count()).toBe(1);
  });

  it("is fast: cached requests take a few milliseconds", async () => {
    const id = await addEvent();
    await request(stack.app).get(`/events/${id}`);
    const times: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const started = performance.now();
      await request(stack.app).get(`/events/${id}`);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    expect(times[15]).toBeLessThan(25); // the median
  });

  it("keeps different events apart", async () => {
    const [a, b] = [await addEvent({ title: "Alpha" }), await addEvent({ title: "Beta" })];
    expect((await request(stack.app).get(`/events/${a}`)).body.title).toBe("Alpha");
    expect((await request(stack.app).get(`/events/${b}`)).body.title).toBe("Beta");
    expect((await request(stack.app).get(`/events/${a}`)).body.title).toBe("Alpha");
  });

  it("keeps different searches apart", async () => {
    await addEvent({ title: "Jazz night", city: "Alpha" });
    await addEvent({ title: "Rock night", city: "Beta" });
    const alpha = await request(stack.app).get("/events?city=Alpha");
    const beta = await request(stack.app).get("/events?city=Beta");
    expect(alpha.body.items.map((i: { title: string }) => i.title)).toEqual(["Jazz night"]);
    expect(beta.body.items.map((i: { title: string }) => i.title)).toEqual(["Rock night"]);
  });

  it("the same search written differently still shares one cache entry", async () => {
    await addEvent({ city: "Mixed" });
    const counter = stack.countQueries(/from "events"/i);
    await request(stack.app).get("/events?city=Mixed");
    await request(stack.app).get("/events?city=MIXED&limit=20");
    await request(stack.app).get("/events?city=%20mixed%20");
    counter.stop();
    expect(counter.count()).toBe(1);
  });
});

describe("two instances share one cache (assignment checks 7 and 8)", () => {
  let one: Instance;
  let two: Instance;
  beforeEach(async () => {
    [one, two] = [await stack.makeInstance(), await stack.makeInstance()];
  });

  it("100 simultaneous requests for a cold event, spread over both instances, cause ONE database query", async () => {
    for (let round = 0; round < 5; round += 1) {
      const id = await addEvent({ title: `Round ${round}` });
      await one.catalog.bump(); // everything cold again
      await sleep(50);

      const counter = stack.countQueries(/from "events"/i);
      const responses = await Promise.all(
        Array.from({ length: 100 }, (_, i) => request(i % 2 === 0 ? one.app : two.app).get(`/events/${id}`)),
      );
      counter.stop();

      expect(responses.every((r) => r.status === 200 && r.body.title === `Round ${round}`)).toBe(true);
      expect(counter.count(), `round ${round}`).toBe(1);
    }
  });

  it("the same for a list and for cities", async () => {
    await addEvent({ city: "Listland" });
    await one.catalog.bump();
    await sleep(50);
    const counter = stack.countQueries(/from "events"/i);
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => request(i % 2 === 0 ? one.app : two.app).get("/events?city=Listland")),
    );
    expect(counter.count()).toBe(1);
    await Promise.all(Array.from({ length: 100 }, (_, i) => request(i % 2 === 0 ? one.app : two.app).get("/cities")));
    counter.stop();
    expect(counter.count()).toBe(2); // one for the list, one for the cities
  });

  it("100 requests for 100 DIFFERENT events are not merged: each is read, each is correct", async () => {
    const ids = await Promise.all(Array.from({ length: 100 }, (_, i) => addEvent({ title: `Event ${i}` })));
    const counter = stack.countQueries(/from "events"/i);
    const responses = await Promise.all(
      ids.map((id, i) => request(i % 2 === 0 ? one.app : two.app).get(`/events/${id}`)),
    );
    counter.stop();
    expect(responses.map((r) => r.body.id)).toEqual(ids);
    expect(counter.count()).toBe(100);
  });

  it("a value one instance already loaded is served by the other from Redis, with no database query", async () => {
    const id = await addEvent();
    const first = await request(one.app).get(`/events/${id}`);
    const counter = stack.countQueries(/from "events"/i);
    const second = await request(two.app).get(`/events/${id}`);
    counter.stop();
    expect(second.body).toEqual(first.body);
    expect(counter.count()).toBe(0);
  });

  it("a change made on one instance is visible on the other at once, every time", async () => {
    const id = await addEvent({ title: "v0" });
    await request(one.app).get(`/events/${id}`);
    await request(two.app).get(`/events/${id}`); // both instances now hold "v0" in memory

    for (let i = 1; i <= 40; i += 1) {
      await stack.db.update(events).set({ title: `v${i}` }).where(eq(events.id, id));
      await one.catalog.bump();
      // Straight away, from the OTHER instance: no waiting.
      const seen = await request(two.app).get(`/events/${id}`);
      expect(seen.body.title, `change ${i}`).toBe(`v${i}`);
    }
  });

  it("lists and cities follow a change too", async () => {
    const id = await addEvent({ title: "Old title", city: "Oldtown" });
    await request(two.app).get("/events?city=Oldtown");
    await request(two.app).get("/cities");

    await stack.db.update(events).set({ title: "New title", city: "Newtown" }).where(eq(events.id, id));
    await one.catalog.bump();

    expect((await request(two.app).get("/events?city=Oldtown")).body.items).toEqual([]);
    expect((await request(two.app).get("/events?city=Newtown")).body.items[0].title).toBe("New title");
    expect((await request(two.app).get("/cities")).body).toContain("Newtown");
    expect((await request(two.app).get("/cities")).body).not.toContain("Oldtown");
  });

  it("without a bump a change is NOT seen yet (the cache really is caching)", async () => {
    const id = await addEvent({ title: "Before" });
    await request(two.app).get(`/events/${id}`);
    await stack.db.update(events).set({ title: "After" }).where(eq(events.id, id));
    expect((await request(two.app).get(`/events/${id}`)).body.title).toBe("Before");
    await one.catalog.bump();
    expect((await request(two.app).get(`/events/${id}`)).body.title).toBe("After");
  });

  it("a new instance that starts later picks up the current generation, not zero", async () => {
    await one.catalog.bump();
    await one.catalog.bump();
    const late = await stack.makeInstance();
    expect(late.catalog.current()).toBe(one.catalog.current());
  });

  it("both instances agree on the generation after bumps from either side", async () => {
    await one.catalog.bump();
    await two.catalog.bump();
    await sleep(100);
    expect(one.catalog.current()).toBe(two.catalog.current());
    expect(one.catalog.current()).toBeGreaterThanOrEqual(2);
  });
});

describe("remembering 'not found'", () => {
  it("asks the database once for an event that does not exist, however often it is requested", async () => {
    const counter = stack.countQueries(/from "events"/i);
    for (let i = 0; i < 50; i += 1) expect((await request(stack.app).get("/events/424242")).status).toBe(404);
    counter.stop();
    expect(counter.count()).toBe(1);
  });

  it("forgets it after a short time, so an event created later appears", async () => {
    const instance = await stack.makeInstance({ cache: { l1TtlMs: 10_000, l2TtlMs: 60_000, negativeTtlMs: 300, availabilityTtlMs: 1000 } });
    const [row] = await stack.db.insert(events).values({ title: "Late", description: "d", city: "c", venue: "v", startsAt: new Date("2031-01-01T00:00:00Z"), capacity: 5 }).returning();
    const id = (row?.id ?? 0) + 1;
    expect((await request(instance.app).get(`/events/${id}`)).status).toBe(404);
    await stack.db.insert(events).values({ title: "Created later", description: "d", city: "c", venue: "v", startsAt: new Date("2031-01-01T00:00:00Z"), capacity: 5 });
    expect((await request(instance.app).get(`/events/${id}`)).status).toBe(404); // still remembered
    await sleep(400);
    await stack.redis.flushall();
    expect((await request(instance.app).get(`/events/${id}`)).status).toBe(200);
  });

  it("is cleared at once by a bump", async () => {
    const [row] = await stack.db.insert(events).values({ title: "Placeholder", description: "d", city: "c", venue: "v", startsAt: new Date("2031-01-01T00:00:00Z"), capacity: 5 }).returning();
    const id = (row?.id ?? 0) + 1;
    expect((await request(stack.app).get(`/events/${id}`)).status).toBe(404);
    await stack.db.insert(events).values({ title: "Appears", description: "d", city: "c", venue: "v", startsAt: new Date("2031-01-01T00:00:00Z"), capacity: 5 });
    await stack.catalog.bump();
    expect((await request(stack.app).get(`/events/${id}`)).body.title).toBe("Appears");
  });
});

describe("when Redis fails", () => {
  function breakable(real: Redis) {
    let broken = false;
    const methods = new Set(["get", "set", "eval"]);
    const proxy = new Proxy(real, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (methods.has(String(property))) {
          return (...args: unknown[]) =>
            broken ? Promise.reject(new Error("redis is down")) : (value as (...a: unknown[]) => unknown).apply(target, args);
        }
        return value.bind(target);
      },
    });
    return { redis: proxy, breakIt: () => void (broken = true) };
  }

  it("events are still served, straight from the database", async () => {
    const id = await addEvent({ title: "Survivor" });
    const flaky = breakable(stack.redis);
    const instance = await stack.makeInstance({}, { cacheRedis: flaky.redis });
    flaky.breakIt();

    const res = await request(instance.app).get(`/events/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Survivor");
    expect((await request(instance.app).get("/events")).status).toBe(200);
    expect((await request(instance.app).get("/cities")).status).toBe(200);
  });

  it("a bump still makes this instance forget, even though it cannot tell the others", async () => {
    const id = await addEvent({ title: "Before" });
    const flaky = breakable(stack.redis);
    const instance = await stack.makeInstance({}, { cacheRedis: flaky.redis });
    await request(instance.app).get(`/events/${id}`);
    flaky.breakIt();
    await stack.db.update(events).set({ title: "After" }).where(eq(events.id, id));
    await expect(instance.catalog.bump()).resolves.toBeGreaterThan(0);
    expect((await request(instance.app).get(`/events/${id}`)).body.title).toBe("After");
  });
});

describe("a loader that never finishes, or fails", () => {
  it("others stop waiting for a lock holder that is gone, and load for themselves", async () => {
    const id = await addEvent({ title: "Orphaned lock" });
    const impatient = await stack.makeInstance({}, { lockWaitMs: 300, pollMs: 10 });
    const gen = impatient.catalog.current();
    // A loader took the lock and disappeared: the lock stays for a long time.
    await stack.redis.set(`lock:event:${gen}:${id}`, "someone-else", "PX", 60_000);

    const started = Date.now();
    const res = await request(impatient.app).get(`/events/${id}`);
    const waited = Date.now() - started;
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Orphaned lock");
    expect(waited).toBeGreaterThanOrEqual(280); // it did wait for the lock...
    expect(waited).toBeLessThan(3000); // ...but not forever
  });

  it("does not remember an error: the next request tries again", async () => {
    const cache = await createCache({ redis: stack.redis, subscriber: stack.redis.duplicate(), logger: createLogger("silent"), l1MaxEntries: 10 });
    const policy: CachePolicy<{ n: number }> = { schema: z.object({ n: z.number() }), l1TtlMs: 5000, l2TtlMs: 5000, negativeTtlMs: 5000 };
    let calls = 0;
    const loader = async () => {
      calls += 1;
      if (calls === 1) throw new Error("database hiccup");
      return { n: calls };
    };
    await expect(cache.getOrLoad("flaky:1", policy, loader)).rejects.toThrow("database hiccup");
    const started = Date.now();
    expect(await cache.getOrLoad("flaky:1", policy, loader)).toEqual({ n: 2 });
    expect(Date.now() - started).toBeLessThan(500); // the failed loader released its lock at once
    await cache.close();
  });
});

describe("the cache on its own", () => {
  const policy = (overrides: Partial<CachePolicy<{ n: number }>> = {}): CachePolicy<{ n: number }> => ({
    schema: z.object({ n: z.number() }),
    l1TtlMs: 5000,
    l2TtlMs: 5000,
    negativeTtlMs: 5000,
    ...overrides,
  });
  const makeCache = (l1MaxEntries = 100) =>
    createCache({ redis: stack.redis, subscriber: stack.redis.duplicate(), logger: createLogger("silent"), l1MaxEntries });

  it("if another instance finished between our look and our lock, we use its result and do not load again", async () => {
    // The first look at the shared level wrongly says "empty" (as if the other instance were still
    // working), although the value is there by the time we hold the lock.
    let firstLookDone = false;
    const lateWriter = new Proxy(stack.redis, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (property === "get") {
          return async (key: string) => {
            if (key.startsWith("cache:") && !firstLookDone) {
              firstLookDone = true;
              return null;
            }
            return target.get(key);
          };
        }
        return value.bind(target);
      },
    });
    const cache = await createCache({ redis: lateWriter, subscriber: stack.redis.duplicate(), logger: createLogger("silent"), l1MaxEntries: 10 });
    const key = `late:${randomUUID()}`;
    await stack.redis.set(`cache:${key}`, JSON.stringify({ v: { n: 1 } }), "PX", 5000);

    let loads = 0;
    const result = await cache.getOrLoad(key, policy(), async () => ({ n: ++loads + 100 }));
    expect(result).toEqual({ n: 1 });
    expect(loads).toBe(0);
    await cache.close();
  });

  it("with Redis down, many requests for one key in one instance still cause one load", async () => {
    const dead = new Proxy(stack.redis, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (["get", "set", "eval"].includes(String(property))) return () => Promise.reject(new Error("redis is down"));
        return value.bind(target);
      },
    });
    const cache = await createCache({ redis: dead, subscriber: stack.redis.duplicate(), logger: createLogger("silent"), l1MaxEntries: 10 });
    let loads = 0;
    const slow = async () => {
      loads += 1;
      await sleep(100);
      return { n: 1 };
    };
    const key = `down:${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 100 }, () => cache.getOrLoad(key, policy(), slow)));
    expect(results.every((r) => r?.n === 1)).toBe(true);
    expect(loads).toBe(1);
    await cache.close();
  });

  it("many callers of one key share one slow load, even across two caches", async () => {
    const [a, b] = [await makeCache(), await makeCache()];
    let calls = 0;
    const slow = async () => {
      calls += 1;
      await sleep(200);
      return { n: 7 };
    };
    const key = `shared:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? a : b).getOrLoad(key, policy(), slow)),
    );
    expect(calls).toBe(1);
    expect(results.every((r) => r?.n === 7)).toBe(true);
    await Promise.all([a.close(), b.close()]);
  });

  it("after the memory level expires, the shared level answers without calling the loader", async () => {
    const cache = await makeCache();
    let calls = 0;
    const loader = async () => ({ n: ++calls });
    const key = `l1expiry:${randomUUID()}`;
    await cache.getOrLoad(key, policy({ l1TtlMs: 100 }), loader);
    await sleep(150);
    expect(await cache.getOrLoad(key, policy({ l1TtlMs: 100 }), loader)).toEqual({ n: 1 });
    expect(calls).toBe(1);
    await cache.close();
  });

  it("after the shared level expires too, it loads again", async () => {
    const cache = await makeCache();
    let calls = 0;
    const loader = async () => ({ n: ++calls });
    const key = `l2expiry:${randomUUID()}`;
    const short = policy({ l1TtlMs: 100, l2TtlMs: 200 });
    await cache.getOrLoad(key, short, loader);
    await sleep(300);
    expect(await cache.getOrLoad(key, short, loader)).toEqual({ n: 2 });
    await cache.close();
  });

  it("a record of the wrong shape in Redis is ignored and replaced", async () => {
    const cache = await makeCache();
    const key = `corrupt:${randomUUID()}`;
    await stack.redis.set(`cache:${key}`, JSON.stringify({ v: { n: "not a number" } }), "PX", 5000);
    expect(await cache.getOrLoad(key, policy(), async () => ({ n: 99 }))).toEqual({ n: 99 });
    await stack.redis.set(`cache:${key}x`, "not json at all", "PX", 5000);
    expect(await cache.getOrLoad(`${key}x`, policy(), async () => ({ n: 5 }))).toEqual({ n: 5 });
    await cache.close();
  });

  it("'not found' is remembered on both levels, for the short time only", async () => {
    const [a, b] = [await makeCache(), await makeCache()];
    let calls = 0;
    const missing = async () => {
      calls += 1;
      return null;
    };
    const key = `missing:${randomUUID()}`;
    const p = policy({ negativeTtlMs: 250 });
    expect(await a.getOrLoad(key, p, missing)).toBeNull();
    expect(await b.getOrLoad(key, p, missing)).toBeNull(); // from Redis
    expect(calls).toBe(1);
    await sleep(350);
    expect(await a.getOrLoad(key, p, missing)).toBeNull();
    expect(calls).toBe(2);
    await Promise.all([a.close(), b.close()]);
  });

  it("memory stays within its limit however many keys pass through", async () => {
    const cache = await makeCache(5);
    let calls = 0;
    const loader = async () => ({ n: ++calls });
    const prefix = `many:${randomUUID()}:`;
    for (let i = 0; i < 30; i += 1) await cache.getOrLoad(`${prefix}${i}`, policy({ l2TtlMs: 0 }), loader);
    expect(calls).toBe(30);
    // The last five are still in memory; the first is long gone and is loaded again.
    await cache.getOrLoad(`${prefix}29`, policy({ l2TtlMs: 0 }), loader);
    expect(calls).toBe(30);
    await cache.getOrLoad(`${prefix}0`, policy({ l2TtlMs: 0 }), loader);
    expect(calls).toBe(31);
    await cache.close();
  });

  it("a slow load that started before a bump cannot show its old value after the bump", async () => {
    const cache = await makeCache();
    const gen = await cache.generation(`race-${randomUUID()}`);
    const keyFor = () => `race:${gen.current()}`;
    let dbValue = "old";

    const slowOld = cache.getOrLoad(keyFor(), stringPolicy(), async () => {
      const seen = dbValue;
      await sleep(200); // reads "old", finishes late
      return { s: seen };
    });
    await sleep(50);
    dbValue = "new";
    await gen.bump();
    const fresh = await cache.getOrLoad(keyFor(), stringPolicy(), async () => ({ s: dbValue }));
    expect(fresh).toEqual({ s: "new" });
    expect(await slowOld).toEqual({ s: "old" }); // the slow caller gets what it asked for...
    expect(await cache.getOrLoad(keyFor(), stringPolicy(), async () => ({ s: "never" }))).toEqual({ s: "new" }); // ...but nobody else does
    await cache.close();

    function stringPolicy(): CachePolicy<{ s: string }> {
      return { schema: z.object({ s: z.string() }), l1TtlMs: 5000, l2TtlMs: 5000, negativeTtlMs: 5000 };
    }
  });

  it("generation numbers only go up and are shared", async () => {
    const [a, b] = [await makeCache(), await makeCache()];
    const name = `gen-${randomUUID()}`;
    const [ga, gb] = [await a.generation(name), await b.generation(name)];
    const seen = [ga.current()];
    for (let i = 0; i < 5; i += 1) seen.push(await ga.bump());
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(new Set(seen).size).toBe(seen.length);
    await sleep(100);
    expect(gb.current()).toBe(ga.current());
    await Promise.all([a.close(), b.close()]);
  });

  it("keeps going up after Redis loses all its data (the numbers never go back)", async () => {
    const cache = await makeCache();
    const gen = await cache.generation(`reset-${randomUUID()}`);
    await gen.bump();
    await gen.bump();
    const before = gen.current();
    await stack.redis.flushall(); // Redis restarted without its data
    const after = await gen.bump();
    expect(after).toBeGreaterThan(before);
    expect(gen.current()).toBe(after);
    await cache.close();
  });

  it("another instance, which also remembers a big number, follows a bump made after Redis was wiped", async () => {
    const [a, b] = [await makeCache(), await makeCache()];
    const name = `reset2-${randomUUID()}`;
    const [ga, gb] = [await a.generation(name), await b.generation(name)];
    await ga.bump();
    await ga.bump();
    await sleep(50);
    await stack.redis.flushall();
    const after = await ga.bump();
    await sleep(100);
    expect(gb.current()).toBe(after);
    await Promise.all([a.close(), b.close()]);
  });

  it("two bumps at the same moment are both counted", async () => {
    const [a, b] = [await makeCache(), await makeCache()];
    const name = `gen-${randomUUID()}`;
    const [ga, gb] = [await a.generation(name), await b.generation(name)];
    const [x, y] = await Promise.all([ga.bump(), gb.bump()]);
    expect(new Set([x, y]).size).toBe(2);
    await sleep(100);
    expect(ga.current()).toBe(Math.max(x, y));
    expect(gb.current()).toBe(Math.max(x, y));
    await Promise.all([a.close(), b.close()]);
  });
});
