import { apiErrorSchema, type ApiError } from "@app/shared";

/** The address of the api as the browser sees it: a path on our own site, nginx forwards it. */
export const API_BASE = "/api";

export type BrowserResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ApiError; message: string };

/** Text for a person, for any failure. The api's own message is used when it speaks to the user (4xx). */
export function describeFailure(status: number, error: ApiError | undefined): string {
  if (status === 429) return error?.message ?? "Too many requests. Please wait a moment and try again.";
  if (status >= 500 || status === 0) return "Something went wrong on our side. Please try again.";
  return error?.message ?? "That did not work. Please try again.";
}

/** Calls the api from the browser. Never throws: network failures come back as `ok: false`. */
export async function callApi<T>(
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<BrowserResult<T>> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers: { accept: "application/json", ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
      signal: options.signal ?? null,
    });
    if (response.status === 204) return { ok: true, status: 204, data: undefined as T };
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true, status: response.status, data: payload as T };
    const parsed = apiErrorSchema.safeParse(payload);
    const error: ApiError = parsed.success ? parsed.data : { code: "UNKNOWN", message: "" };
    return { ok: false, status: response.status, error, message: describeFailure(response.status, parsed.success ? parsed.data : undefined) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return {
      ok: false,
      status: 0,
      error: { code: "NETWORK", message: "" },
      message: "We could not reach the server. Check your connection and try again.",
    };
  }
}

/** Field messages from a validation answer: `{ email: ["Email must be a valid email address"] }`. */
export function fieldErrorsOf(error: ApiError): Record<string, string[]> {
  const fields = error.details?.["fields"];
  if (typeof fields !== "object" || fields === null) return {};
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string[]] => Array.isArray(entry[1])),
  );
}
