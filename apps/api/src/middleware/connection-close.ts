import type { RequestHandler } from "express";

/** While shutting down, tell clients not to reuse the connection, so it closes after the reply. */
export function createConnectionClose(isShuttingDown: () => boolean): RequestHandler {
  return (_req, res, next) => {
    if (isShuttingDown()) res.setHeader("Connection", "close");
    next();
  };
}
