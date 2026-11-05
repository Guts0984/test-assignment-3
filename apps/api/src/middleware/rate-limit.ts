import { ErrorCode } from "@app/shared";
import type { RequestHandler } from "express";
import type { LimitRule, RateLimiter } from "../infra/rate-limiter";
import { createAppError } from "../lib/app-error";
import { getClient } from "./client-ip";

/** The ready-made 429 answer, with a Retry-After header. */
export const tooManyRequests = (resetSeconds: number, message = "Too many requests. Please wait a moment and try again.") =>
  createAppError(429, ErrorCode.RATE_LIMITED, message, {
    details: { retryAfterSeconds: resetSeconds },
    headers: { "Retry-After": String(resetSeconds) },
  });

const exemptPaths = new Set(["/health", "/ready"]);

/**
 * At most `rule.max` requests per visitor address per window, for every instance together.
 * Our own web server's calls that are not for a particular visitor (cached page data) are not
 * counted, so rendering a page never uses up the one shared allowance of all visitors.
 */
export function createRateLimit(limiter: RateLimiter, rule: LimitRule): RequestHandler {
  return async (req, res, next) => {
    const client = getClient(res);
    if (client.internal || exemptPaths.has(req.path)) {
      next();
      return;
    }

    const result = await limiter.consume(`ip:${client.ip}`, rule);
    res.setHeader("RateLimit-Limit", String(rule.max));
    res.setHeader("RateLimit-Remaining", String(result.remaining));
    res.setHeader("RateLimit-Reset", String(result.resetSeconds));
    if (!result.allowed) throw tooManyRequests(result.resetSeconds);
    next();
  };
}
