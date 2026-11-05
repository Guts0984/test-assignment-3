import { verifyInternalRequest } from "@app/shared/internal";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import { CITIES_TAG, EVENTS_TAG, eventTag } from "@/features/event/server";
import { getEnv } from "@/shared/config/env";
import { logger } from "@/shared/logger";

const bodySchema = z.object({ eventId: z.number().int().positive(), version: z.number().int().positive() });

/**
 * The worker calls this after an event changed. It is not for browsers (nginx does not pass it on), and
 * it only answers to a request signed with the secret that only our own programs know.
 * It clears the cached copies of that event, of the lists and of the cities, so the next visitor sees the change.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? undefined;
  const headers = Object.fromEntries(request.headers.entries());
  if (!verifyInternalRequest(getEnv().INTERNAL_API_SECRET, headers).trusted) {
    logger.warn({ requestId }, "refresh refused: bad signature");
    return Response.json({ code: "UNAUTHENTICATED", message: "Not allowed." }, { status: 401 });
  }

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ code: "VALIDATION_ERROR", message: "Expected {eventId, version}." }, { status: 400 });

  // { expire: 0 }: the old copy is not served again, the next visitor waits for a fresh one.
  revalidateTag(eventTag(body.data.eventId), { expire: 0 });
  revalidateTag(EVENTS_TAG, { expire: 0 });
  revalidateTag(CITIES_TAG, { expire: 0 });
  logger.info({ requestId, eventId: body.data.eventId, version: body.data.version }, "cached copies cleared");

  // Build the new pages now, in the background, so the next visitor (or nginx, when its 5-second copy runs out) does not
  // have to wait for a fresh render. The answer to the worker does not wait for this.
  const base = `http://127.0.0.1:${process.env["PORT"] ?? "3000"}`;
  for (const path of [`/events/${body.data.eventId}`, "/"]) {
    void fetch(`${base}${path}`, { headers: { "x-request-id": requestId ?? crypto.randomUUID() } }).catch(() => undefined);
  }
  return Response.json({ ok: true });
}
