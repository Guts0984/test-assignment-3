import { idempotencyKeys, outbox, type Database } from "@app/db";
import { and, isNotNull, lt, sql } from "drizzle-orm";

/** Old bookkeeping goes away: repeat-protection keys after a day, finished outbox notes after a week. */
export async function cleanOldRecords(db: Database): Promise<{ keys: number; notes: number }> {
  const keys = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, sql`now() - interval '24 hours'`))
    .returning({ key: idempotencyKeys.key });
  const notes = await db
    .delete(outbox)
    .where(and(isNotNull(outbox.dispatchedAt), lt(outbox.dispatchedAt, sql`now() - interval '7 days'`)))
    .returning({ id: outbox.id });
  return { keys: keys.length, notes: notes.length };
}
