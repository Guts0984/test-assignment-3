import { randomUUID } from "node:crypto";
import { CACHE_GENERATION_CHANNEL, generationKey } from "@app/shared";
import { z } from "zod";
import type { Logger } from "../logger";
import type { Redis } from "../redis";
import { createMemoryCache } from "./memory-cache";

/** How one family of cached values behaves. */
export interface CachePolicy<T> {
  /** Checks what comes back from Redis; a value of the wrong shape counts as a miss. */
  schema: z.ZodType<T>;
  l1TtlMs: number;
  /** 0 means: keep it in this process only, do not use Redis. */
  l2TtlMs: number;
  /** How long "this does not exist" (a `null` result) is remembered, on both levels. */
  negativeTtlMs: number;
}

/**
 * A counter shared by all api instances. It is part of cache keys, so adding 1 to it makes
 * every older entry unreachable at once, on every instance, without searching for them.
 */
export interface Generation {
  current: () => number;
  /** Add 1, tell every instance, and return the new number. Call after the change is committed. */
  bump: () => Promise<number>;
}

export interface Cache {
  /**
   * Returns the cached value for `key`, or runs `loader` (the database query) and remembers the result.
   * Many callers asking for the same key at once share one `loader` run, even across instances.
   * A `null` from the loader means "not found" and is remembered for a short time too.
   * Errors from the loader are never remembered.
   */
  getOrLoad: <T>(key: string, policy: CachePolicy<T>, loader: () => Promise<T | null>) => Promise<T | null>;
  generation: (name: string) => Promise<Generation>;
  /** Forget a key in this process only. */
  forgetLocal: (key: string) => void;
  close: () => Promise<void>;
}

export interface CacheOptions {
  redis: Pick<Redis, "get" | "set" | "eval">;
  /** A separate connection: a connection that subscribes cannot run other commands. */
  subscriber: Pick<Redis, "subscribe" | "on" | "disconnect">;
  logger: Logger;
  l1MaxEntries: number;
  /** How long a loader may hold the lock before others stop waiting for it. */
  lockTtlMs?: number;
  /** How long others wait for the loader before they load for themselves. */
  lockWaitMs?: number;
  pollMs?: number;
  now?: () => number;
}

const VALUE_PREFIX = "cache:";
const LOCK_PREFIX = "lock:";
// Only the owner may release a lock: compare the token first, then delete.
const RELEASE_LOCK = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

// A new generation is the Redis clock in milliseconds, or one more than the current number if that is
// bigger. It always goes up, and it keeps going up even if Redis lost its data (a plain counter would
// start again from 1, below what instances remember, and nothing would be cleared). The script also
// announces the new number to every instance, in the same step.
const BUMP_GENERATION = `
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local next = math.max(current + 1, now)
redis.call("SET", KEYS[1], next)
redis.call("PUBLISH", ARGV[1], string.format('{"name":"%s","gen":%d}', ARGV[2], next))
return next
`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Attempt<R> = { ok: true; value: R } | { ok: false };
type Found<T> = { hit: true; value: T | null } | { hit: false };

const generationMessage = z.object({ name: z.string(), gen: z.number().int() });

export async function createCache({
  redis,
  subscriber,
  logger,
  l1MaxEntries,
  lockTtlMs = 10_000,
  lockWaitMs = 3_000,
  pollMs = 15,
  now = Date.now,
}: CacheOptions): Promise<Cache> {
  // Level 1. Values are JSON-like and treated as read-only by everyone.
  const l1 = createMemoryCache<unknown>({ maxEntries: l1MaxEntries, now });
  const inFlight = new Map<string, Promise<unknown>>();
  const generations = new Map<string, number>();

  /** Redis is an optimisation. If it fails, we log and carry on without it. */
  async function attempt<R>(what: string, operation: () => Promise<R>): Promise<Attempt<R>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error), what }, "cache: redis unavailable");
      return { ok: false };
    }
  }

  async function readShared<T>(key: string, schema: z.ZodType<T>): Promise<Attempt<Found<T>>> {
    const result = await attempt("get", () => redis.get(VALUE_PREFIX + key));
    if (!result.ok) return result;
    if (result.value === null) return { ok: true, value: { hit: false } };
    try {
      const envelope: unknown = JSON.parse(result.value);
      if (typeof envelope !== "object" || envelope === null || !("v" in envelope)) {
        return { ok: true, value: { hit: false } };
      }
      if (envelope.v === null) return { ok: true, value: { hit: true, value: null } };
      const parsed = schema.safeParse(envelope.v);
      return { ok: true, value: parsed.success ? { hit: true, value: parsed.data } : { hit: false } };
    } catch {
      return { ok: true, value: { hit: false } };
    }
  }

  async function loadThroughBothLevels<T>(
    key: string,
    policy: CachePolicy<T>,
    loader: () => Promise<T | null>,
  ): Promise<T | null> {
    const ttlFor = (value: T | null, normalMs: number) => (value === null ? policy.negativeTtlMs : normalMs);
    const remember = (value: T | null) => l1.set(key, value, ttlFor(value, policy.l1TtlMs));
    const share = (value: T | null) =>
      attempt("set", () =>
        redis.set(VALUE_PREFIX + key, JSON.stringify({ v: value }), "PX", Math.max(1, ttlFor(value, policy.l2TtlMs))),
      );

    // Only this process: no Redis, no lock.
    if (policy.l2TtlMs <= 0) {
      const value = await loader();
      remember(value);
      return value;
    }

    const deadline = now() + lockWaitMs;
    for (;;) {
      const found = await readShared(key, policy.schema);
      if (!found.ok) break; // Redis is down: just load
      if (found.value.hit) {
        remember(found.value.value);
        return found.value.value;
      }

      // Nobody has the value. The first to take the lock loads it; the others wait for the result.
      const token = randomUUID();
      const lock = await attempt("lock", () => redis.set(LOCK_PREFIX + key, token, "PX", lockTtlMs, "NX"));
      if (!lock.ok) break;

      if (lock.value === "OK") {
        try {
          // Someone may have finished between our read and our lock: look again before loading.
          const again = await readShared(key, policy.schema);
          if (again.ok && again.value.hit) {
            remember(again.value.value);
            return again.value.value;
          }
          const value = await loader();
          await share(value);
          remember(value);
          return value;
        } finally {
          await attempt("unlock", () => redis.eval(RELEASE_LOCK, 1, LOCK_PREFIX + key, token));
        }
      }

      if (now() >= deadline) break; // the other loader is too slow or gone: stop waiting
      await sleep(pollMs);
    }

    const value = await loader();
    await share(value);
    remember(value);
    return value;
  }

  function getOrLoad<T>(key: string, policy: CachePolicy<T>, loader: () => Promise<T | null>): Promise<T | null> {
    const local = l1.get(key);
    // Safe: a key always belongs to one policy, so what is stored under it has that policy's type.
    if (local) return Promise.resolve(local.value as T | null);

    const running = inFlight.get(key);
    if (running) return running as Promise<T | null>;

    const promise = loadThroughBothLevels(key, policy, loader).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  // Generations: every instance hears about a bump through Redis pub/sub.
  const raise = (name: string, gen: number) => {
    if (gen > (generations.get(name) ?? 0)) generations.set(name, gen);
  };
  subscriber.on("message", (channel: string, message: string) => {
    if (channel !== CACHE_GENERATION_CHANNEL) return;
    try {
      const parsed = generationMessage.safeParse(JSON.parse(message));
      if (parsed.success) raise(parsed.data.name, parsed.data.gen);
    } catch {
      // not our message
    }
  });

  async function readGeneration(name: string): Promise<void> {
    const stored = await attempt("generation", () => redis.get(generationKey(name)));
    if (stored.ok && stored.value !== null) raise(name, Number(stored.value));
  }
  // After a reconnect we may have missed messages: read the current numbers again.
  subscriber.on("ready", () => {
    for (const name of generations.keys()) void readGeneration(name);
  });
  await subscriber.subscribe(CACHE_GENERATION_CHANNEL);

  return {
    getOrLoad,

    async generation(name) {
      await readGeneration(name);
      if (!generations.has(name)) generations.set(name, 0);
      return {
        current: () => generations.get(name) ?? 0,
        bump: async () => {
          const next = await attempt("bump", async () => {
            const gen = await redis.eval(BUMP_GENERATION, 1, generationKey(name), CACHE_GENERATION_CHANNEL, name);
            return Number(gen);
          });
          // Without Redis we can still make this process forget; other instances rely on TTLs.
          const gen = next.ok ? next.value : (generations.get(name) ?? 0) + 1;
          raise(name, gen);
          return gen;
        },
      };
    },

    forgetLocal: (key) => l1.delete(key),

    close: async () => {
      subscriber.disconnect();
    },
  };
}
