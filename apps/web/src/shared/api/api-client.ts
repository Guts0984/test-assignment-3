import "server-only";
import { apiErrorSchema } from "@app/shared";
import { signInternalRequest } from "@app/shared/internal";
import type { z } from "zod";
import { getEnv } from "@/shared/config/env";

/** The api said no, or could not be reached. */
export interface ApiRequestError extends Error {
  readonly isApiRequestError: true;
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown> | undefined;
}

function createApiRequestError(status: number, code: string, message: string, details?: Record<string, unknown>): ApiRequestError {
  return Object.assign(new Error(message), { name: "ApiRequestError", isApiRequestError: true as const, status, code, details });
}

export const isApiRequestError = (error: unknown): error is ApiRequestError =>
  error instanceof Error && "isApiRequestError" in error;

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** The visitor's `Cookie` header, to act as them. */
  cookie?: string | undefined;
  /** The visitor's address, so the api counts the request against them and not against us. */
  ip?: string | undefined;
  requestId?: string | undefined;
}

/**
 * Calls the api from the server, signed so the api knows it is us. With a visitor's address the request
 * counts for that visitor; without one (cached page data) it is not counted at all.
 * Throws an ApiRequestError for any answer that is not a success.
 */
export async function apiCall<T>(path: string, schema: z.ZodType<T>, options: ApiRequestOptions = {}): Promise<T> {
  const env = getEnv();
  const headers: Record<string, string> = {
    accept: "application/json",
    ...signInternalRequest(env.INTERNAL_API_SECRET, options.ip),
  };
  if (options.requestId) headers["x-request-id"] = options.requestId;
  if (options.cookie) headers["cookie"] = options.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(new URL(path, env.API_URL), {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
    });
  } catch {
    throw createApiRequestError(503, "API_UNREACHABLE", "The service is not reachable right now.");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(payload);
    throw error.success
      ? createApiRequestError(response.status, error.data.code, error.data.message, error.data.details)
      : createApiRequestError(response.status, "UNKNOWN", `The service answered ${response.status}.`);
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw createApiRequestError(502, "BAD_API_RESPONSE", "The service sent an answer we could not read.");
  return parsed.data;
}

/** Like apiCall, but "not found" gives null. */
export async function apiCallOrNull<T>(path: string, schema: z.ZodType<T>, options: ApiRequestOptions = {}): Promise<T | null> {
  try {
    return await apiCall(path, schema, options);
  } catch (error) {
    if (isApiRequestError(error) && error.status === 404) return null;
    throw error;
  }
}
