import { ErrorCode, type ApiError } from "@app/shared";
import type { ErrorRequestHandler } from "express";
import type { Logger } from "../infra/logger";
import { isAppError } from "../lib/app-error";

interface BodyParserError {
  type: string;
  status: number;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    typeof error.type === "string" &&
    "status" in error &&
    typeof error.status === "number"
  );
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const send = (status: number, body: ApiError, headers: Record<string, string> = {}) => {
      res.set(headers).status(status).json(body);
    };

    if (isAppError(error)) {
      send(error.status, { code: error.code, message: error.message, details: error.details }, error.headers);
      return;
    }

    if (isBodyParserError(error)) {
      if (error.type === "entity.too.large") {
        send(413, { code: ErrorCode.PAYLOAD_TOO_LARGE, message: "The request body is too large." });
        return;
      }
      if (error.type === "entity.parse.failed") {
        send(400, {
          code: ErrorCode.VALIDATION_ERROR,
          message: "The request body is not valid JSON.",
          details: { fields: { body: ["The request body is not valid JSON."] } },
        });
        return;
      }
    }

    // Anything else is our bug: log everything, tell the client nothing about the inside.
    logger.error({ err: error }, "unhandled error");
    send(500, { code: ErrorCode.INTERNAL_ERROR, message: "Something went wrong on our side. Please try again." });
  };
}
