import { outbox, type Database } from "@app/db";
import { INTERNAL_IP_HEADER, signInternalRequest } from "@app/shared/internal";
import { and, eq, isNull } from "drizzle-orm";

export interface RevalidateJobData {
  eventId: number;
  version: number;
  /** The request that made the change, so its id appears in every log line along the way. */
  requestId?: string | undefined;
}

export interface RevalidateOptions {
  url: string;
  secret: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * Tells the web app that an event changed, with a signed request only our own programs can make.
 * Throws if the web app does not answer with success, so the queue tries again later.
 * Telling it twice does no harm: it only clears cached pages.
 */
export async function sendRevalidation(
  { url, secret, timeoutMs, fetchImpl = fetch }: RevalidateOptions,
  data: RevalidateJobData,
): Promise<void> {
  const signed = signInternalRequest(secret);
  delete signed[INTERNAL_IP_HEADER];
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signed,
      ...(data.requestId ? { "x-request-id": data.requestId } : {}),
    },
    body: JSON.stringify({ eventId: data.eventId, version: data.version }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Read the body so the connection can be reused, then judge by the status.
  await response.arrayBuffer().catch(() => undefined);
  if (!response.ok) throw new Error(`the web app answered ${response.status}`);
}

/** Only after the web app has been told is the note in the outbox checked off. */
export async function markDispatched(db: Database, eventId: number, version: number): Promise<void> {
  await db
    .update(outbox)
    .set({ dispatchedAt: new Date() })
    .where(and(eq(outbox.eventId, eventId), eq(outbox.eventVersion, version), isNull(outbox.dispatchedAt)));
}

/** Has the web app already been told about this version? (Another worker may have done it a moment ago.) */
export async function isAlreadyDispatched(db: Database, eventId: number, version: number): Promise<boolean> {
  const [row] = await db
    .select({ dispatchedAt: outbox.dispatchedAt })
    .from(outbox)
    .where(and(eq(outbox.eventId, eventId), eq(outbox.eventVersion, version)))
    .limit(1);
  // No note at all (cleaned away) also means: nothing left to do.
  return row === undefined || row.dispatchedAt !== null;
}
