import type { RequestHandler } from "express";
import type { Logger } from "../infra/logger";

export function createAccessLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    const requestId = res.getHeader("x-request-id");

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.info(
        { requestId, method: req.method, path: req.path, status: res.statusCode, durationMs: Math.round(durationMs) },
        "request completed",
      );
    });
    next();
  };
}
