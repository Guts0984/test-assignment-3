import { ErrorCode } from "@app/shared";

const appErrorBrand: unique symbol = Symbol("AppError");

export interface AppError extends Error {
  readonly [appErrorBrand]: true;
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
}

export function createAppError(
  status: number,
  code: string,
  message: string,
  extra: {
    details?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): AppError {
  return Object.assign(new Error(message), {
    name: "AppError",
    [appErrorBrand]: true as const,
    status,
    code,
    details: extra.details,
    headers: extra.headers,
  });
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof Error && appErrorBrand in error;
}

export const validationFailed = (
  fields: Record<string, string[]>,
  message = "Some fields are not valid.",
) =>
  createAppError(400, ErrorCode.VALIDATION_ERROR, message, {
    details: { fields },
  });

export const notFound = (message: string) =>
  createAppError(404, ErrorCode.NOT_FOUND, message);

export const notReady = (message: string, details?: Record<string, unknown>) =>
  createAppError(503, ErrorCode.NOT_READY, message, { details });
