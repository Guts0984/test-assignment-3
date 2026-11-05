import { ErrorCode, publicUserSchema, type PublicUser } from "@app/shared";
import { parseCookie } from "cookie";
import type { RequestHandler, Response } from "express";
import { createAppError } from "../lib/app-error";

export const SESSION_COOKIE = "sid";

interface SessionLookup {
  userForSession: (sessionId: string) => Promise<PublicUser | undefined>;
}

/** The logged-in user of this request, if the session middleware found one. */
export function getCurrentUser(res: Response): PublicUser | undefined {
  const parsed = publicUserSchema.safeParse(res.locals["user"]);
  return parsed.success ? parsed.data : undefined;
}

/** Reads the session cookie and, if it is valid, remembers who the user is. Never rejects a request. */
export function createSessionLoader(auth: SessionLookup): RequestHandler {
  return async (req, res, next) => {
    const sessionId = parseCookie(req.headers.cookie ?? "")[SESSION_COOKIE];
    if (sessionId) {
      const user = await auth.userForSession(sessionId);
      if (user) res.locals["user"] = user;
    }
    next();
  };
}

export const requireUser: RequestHandler = (_req, res, next) => {
  if (!getCurrentUser(res)) {
    throw createAppError(401, ErrorCode.UNAUTHENTICATED, "Please log in to continue.");
  }
  next();
};

export const requireAdmin: RequestHandler = (_req, res, next) => {
  const user = getCurrentUser(res);
  if (!user) throw createAppError(401, ErrorCode.UNAUTHENTICATED, "Please log in to continue.");
  if (user.role !== "admin") {
    throw createAppError(403, ErrorCode.FORBIDDEN, "Only administrators can do this.");
  }
  next();
};

const changingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Blocks requests that a different website made with the visitor's cookies. Browsers always send
 * `Origin` on such requests; if it names another host, we refuse. Requests with no `Origin`
 * (our own web server, curl) are allowed: they cannot ride on a victim's browser.
 */
export const requireSameOrigin: RequestHandler = (req, _res, next) => {
  const origin = req.headers.origin;
  if (changingMethods.has(req.method) && origin !== undefined) {
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = undefined;
    }
    if (originHost !== req.headers.host) {
      throw createAppError(403, ErrorCode.FORBIDDEN, "This request came from another website and was blocked.");
    }
  }
  next();
};
