import { outbox, type Database } from "@app/db";
import { asc, isNull } from "drizzle-orm";
import type { RevalidateJobData } from "./revalidate";

export interface RevalidateQueue {
  add: (
    name: string,
    data: RevalidateJobData,
    options: { jobId: string; attempts: number; backoff: { type: "exponential"; delay: number }; removeOnComplete: boolean; removeOnFail: { age: number } },
  ) => Promise<unknown>;
}

export interface OutboxOptions {
  attempts: number;
  backoffMs: number;
  limit?: number;
}

/**
 * Turns every unchecked note in the outbox (an event changed, by anyone, any way) into a queue job.
 * The job id is made from the event and its version, so asking twice, from this worker or another,
 * is the same as asking once. Returns how many notes were looked at.
 */
export async function enqueuePendingRevalidations(
  db: Database,
  queue: RevalidateQueue,
  { attempts, backoffMs, limit = 200 }: OutboxOptions,
): Promise<number> {
  const pending = await db
    .select({ eventId: outbox.eventId, version: outbox.eventVersion, requestId: outbox.requestId })
    .from(outbox)
    .where(isNull(outbox.dispatchedAt))
    .orderBy(asc(outbox.id))
    .limit(limit);

  await Promise.all(
    pending.map((note) =>
      queue.add(
        "revalidate",
        { eventId: note.eventId, version: note.version, requestId: note.requestId ?? undefined },
        {
          jobId: `revalidate-${note.eventId}-${note.version}`,
          attempts,
          backoff: { type: "exponential", delay: backoffMs },
          removeOnComplete: true,
          // A job that used up all its attempts is forgotten after an hour; the note is still unchecked,
          // so the next look at the outbox makes a fresh job and tries again.
          removeOnFail: { age: 3600 },
        },
      ),
    ),
  );
  return pending.length;
}
