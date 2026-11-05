import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/shared/logger";

/**
 * Runs before every page request. It writes one log line with the request id that nginx made (the same id is in
 * the nginx and api logs), and sends the id back in the `x-request-id` header so it can be copied from the browser.
 * Static files and the Docker health check are skipped (see `matcher`), they would only be noise.
 */
export function proxy(request: NextRequest): NextResponse {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  logger.info({ requestId, method: request.method, path: request.nextUrl.pathname }, "request received");

  // A request that came without an id (not through nginx) gets one here, so the api calls it makes carry it too.
  const forwarded = new Headers(request.headers);
  forwarded.set("x-request-id", requestId);
  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  matcher: ["/((?!_next/|healthz|icon\\.svg|internal/).*)"],
};
