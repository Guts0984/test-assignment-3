import type { RequestHandler } from "express";

/**
 * While shutting down:
 *  - requests that start now are told to close their connection after the answer;
 *  - requests that were already running (or live streams that end because we ask them to) close
 *    their connection as soon as their answer has been completely sent. `socket.end()` sends what
 *    is still waiting and then closes; destroying the socket instead could cut the answer short.
 */
export function createConnectionClose(isShuttingDown: () => boolean): RequestHandler {
  return (req, res, next) => {
    if (isShuttingDown()) res.setHeader("Connection", "close");
    res.on("finish", () => {
      if (isShuttingDown()) req.socket.end();
    });
    next();
  };
}
