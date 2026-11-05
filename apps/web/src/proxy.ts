import { publicUserSchema } from "@app/shared";
import { NextResponse, type NextRequest } from "next/server";
import { apiCall, isApiRequestError } from "@/shared/api/api-client";
import { areaOf, decideAccess, loginUrlPath, type Session } from "@/shared/lib/access";
import { logger } from "@/shared/logger";

const forbiddenPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>No access · Event Tickets</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>You do not have access to this page</h1>
<p>This page is only for administrators.</p><p><a href="/">Back to the events</a></p></body></html>`;

/** What kind of visitor is this? Only asks the api when the page needs an administrator. */
async function sessionOf(request: NextRequest, needsRole: boolean, requestId: string): Promise<Session | "unknown"> {
  const cookie = request.headers.get("cookie");
  if (!request.cookies.get("sid") || !cookie) return "none";
  if (!needsRole) return "user"; // the page itself still checks the session; a stale cookie is sent to log in there
  const ip = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || undefined;
  try {
    const user = await apiCall("/me", publicUserSchema, { cookie, ip, requestId });
    return user.role;
  } catch (error) {
    if (isApiRequestError(error) && error.status === 401) return "none";
    return "unknown"; // the api is not answering: let the page show its own error rather than guess
  }
}

/**
 * Runs before every page request.
 * 1. Writes one log line with the request id that nginx made (the same id is in the nginx and api logs), and sends
 *    the id back in the `x-request-id` header so it can be copied from the browser.
 * 2. Closes the pages for logged-in visitors (/me, /checkout) and administrators (/admin) with a real status:
 *    307 to the login page for someone who is not logged in, 403 for someone who is logged in but not an administrator.
 * Static files and the Docker health check are skipped (see `matcher`).
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const { pathname, search } = request.nextUrl;
  logger.info({ requestId, method: request.method, path: pathname }, "request received");

  const area = areaOf(pathname);
  const session = area ? await sessionOf(request, area === "admin", requestId) : "none";
  const access = session === "unknown" ? ({ kind: "allow" } as const) : decideAccess(area, session, pathname + search);

  if (access.kind === "login") {
    const target = request.nextUrl.clone();
    const [path, query] = loginUrlPath(access.next).split("?");
    target.pathname = path ?? "/login";
    target.search = query ? `?${query}` : "";
    const response = NextResponse.redirect(target, 307);
    response.headers.set("x-request-id", requestId);
    response.headers.set("cache-control", "no-store");
    return response;
  }
  if (access.kind === "forbidden") {
    return new NextResponse(forbiddenPage, {
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId },
    });
  }

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
