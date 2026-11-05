import { createHash } from "node:crypto";
import type { LimitRule, RateLimiter } from "../../infra/rate-limiter";
import { tooManyRequests } from "../../middleware/rate-limit";

export interface LoginGuard {
  /** Counts this attempt and refuses it (429) if the address or the account has tried too often. */
  before: (ip: string, email: string) => Promise<void>;
  /** A correct password clears the account's count, so a real user is never locked out by their own typos. */
  succeeded: (email: string) => Promise<void>;
}

export interface LoginGuardDeps {
  limiter: RateLimiter;
  perIp: LimitRule;
  perEmail: LimitRule;
}

/** Logging in is the one place where guessing passwords is possible, so it has its own, stricter limits. */
export function createLoginGuard({ limiter, perIp, perEmail }: LoginGuardDeps): LoginGuard {
  // Hashed so no email address sits in Redis, and so odd characters can never matter in a key.
  const emailKey = (email: string) => `login:email:${createHash("sha256").update(email).digest("hex")}`;

  return {
    async before(ip, email) {
      const byIp = await limiter.consume(`login:ip:${ip}`, perIp);
      if (!byIp.allowed) {
        throw tooManyRequests(byIp.resetSeconds, "Too many login attempts from this address. Please try again later.");
      }
      const byEmail = await limiter.consume(emailKey(email), perEmail);
      if (!byEmail.allowed) {
        throw tooManyRequests(byEmail.resetSeconds, "Too many login attempts for this account. Please try again later.");
      }
    },

    succeeded: (email) => limiter.reset(emailKey(email)),
  };
}
