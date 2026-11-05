import type { Logger } from "./logger";
import type { Redis } from "./redis";

export interface LimitRule {
  max: number;
  windowSeconds: number;
}

export interface LimitResult {
  /** False once more than `max` requests were counted in the current window. */
  allowed: boolean;
  count: number;
  remaining: number;
  /** Seconds until the window ends and the count starts again. */
  resetSeconds: number;
}

export interface RateLimiter {
  /** Counts one request for `key` and says whether it is within the rule. */
  consume: (key: string, rule: LimitRule) => Promise<LimitResult>;
  /** Forgets the count for `key` (e.g. after a successful login). */
  reset: (key: string) => Promise<void>;
}

// Add 1 and read the time left, in one step, so two instances cannot both think they were first.
// If the key somehow has no expiry, give it one: a counter must never live forever.
const COUNT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

const PREFIX = "rl:";

/** Fixed windows kept in Redis, so every api instance counts into the same numbers. */
export function createRateLimiter(redis: Pick<Redis, "eval" | "del">, logger: Logger): RateLimiter {
  return {
    async consume(key, { max, windowSeconds }) {
      try {
        const reply = (await redis.eval(COUNT, 1, PREFIX + key, windowSeconds)) as [number, number];
        const [count, ttl] = reply;
        return { allowed: count <= max, count, remaining: Math.max(0, max - count), resetSeconds: Math.max(1, ttl) };
      } catch (error) {
        // If Redis is down we let requests through rather than shut the whole site.
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, "rate limit unavailable, letting the request through");
        return { allowed: true, count: 0, remaining: max, resetSeconds: windowSeconds };
      }
    },

    async reset(key) {
      try {
        await redis.del(PREFIX + key);
      } catch (error) {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, "could not reset a rate limit");
      }
    },
  };
}
