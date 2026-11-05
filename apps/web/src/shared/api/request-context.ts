import "server-only";
import { headers } from "next/headers";

export interface RequestContext {
  cookie: string | undefined;
  /** The visitor's address as nginx saw it. */
  ip: string | undefined;
  requestId: string | undefined;
}

/** What this request tells us about the visitor. Only for code that runs per request (inside Suspense). */
export async function getRequestContext(): Promise<RequestContext> {
  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for");
  return {
    cookie: incoming.get("cookie") ?? undefined,
    // nginx writes exactly one address; if there are several, the last one was added by the nearest proxy.
    ip: forwarded?.split(",").at(-1)?.trim() || undefined,
    requestId: incoming.get("x-request-id") ?? undefined,
  };
}
