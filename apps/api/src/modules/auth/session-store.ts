import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Redis } from "../../infra/redis";

/** 32 random bytes written in base64url are exactly 43 characters of letters, digits, "-" and "_". */
const SESSION_ID_BYTES = 32;
const sessionIdFormat = /^[A-Za-z0-9_-]{43}$/;

const storedSessionSchema = z.object({ userId: z.uuid() });

/**
 * The Redis key for a session. Only a hash of the session id is stored, never the id itself:
 * whoever can read Redis sees values that cannot be used as a login cookie.
 */
export const sessionKey = (sessionId: string): string =>
  `sess:${createHash("sha256").update(sessionId).digest("hex")}`;

export interface SessionStore {
  /** Starts a session for the user. The returned id is what goes into the cookie. */
  create: (userId: string) => Promise<{ sessionId: string; ttlSeconds: number }>;
  /** Finds the user of a session id, and renews the session for another full period. */
  find: (sessionId: string) => Promise<{ userId: string } | undefined>;
  /** Ends the session at once. Unknown or malformed ids are ignored. */
  destroy: (sessionId: string) => Promise<void>;
}

export interface SessionStoreDeps {
  redis: Pick<Redis, "set" | "getex" | "del">;
  ttlSeconds: number;
}

export function createSessionStore({ redis, ttlSeconds }: SessionStoreDeps): SessionStore {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error(`Session lifetime must be a whole number of seconds, at least 1 (got ${ttlSeconds}).`);
  }

  return {
    async create(userId) {
      const sessionId = randomBytes(SESSION_ID_BYTES).toString("base64url");
      await redis.set(sessionKey(sessionId), JSON.stringify({ userId }), "EX", ttlSeconds);
      return { sessionId, ttlSeconds };
    },

    async find(sessionId) {
      // The id comes from a cookie, so anyone can send anything. Wrong shape: no need to ask Redis.
      if (!sessionIdFormat.test(sessionId)) return undefined;

      // GETEX reads the value and renews the expiry in one step.
      const raw = await redis.getex(sessionKey(sessionId), "EX", ttlSeconds);
      if (raw === null) return undefined;

      try {
        const stored = storedSessionSchema.safeParse(JSON.parse(raw));
        return stored.success ? { userId: stored.data.userId } : undefined;
      } catch {
        return undefined; // not JSON: treat a damaged record as no session
      }
    },

    async destroy(sessionId) {
      if (!sessionIdFormat.test(sessionId)) return;
      await redis.del(sessionKey(sessionId));
    },
  };
}
