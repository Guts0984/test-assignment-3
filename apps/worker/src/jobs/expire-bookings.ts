import { events, type Database } from "@app/db";
import { availabilityChannel } from "@app/shared";
import { eq, sql } from "drizzle-orm";
import type { Logger } from "../logger";

export interface SeatsAnnouncer {
  publish: (channel: string, message: string) => Promise<unknown>;
}

/** Tells everyone watching an event how many seats are free now (same message the api sends). */
export async function announceSeats(db: Database, redis: SeatsAnnouncer, eventId: number): Promise<void> {
  const [row] = await db
    .select({ capacity: events.capacity, bookedSeats: events.bookedSeats })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!row) return;
  const message = { eventId, capacity: row.capacity, available: Math.max(0, row.capacity - row.bookedSeats) };
  await redis.publish(availabilityChannel(eventId), JSON.stringify(message));
}

/**
 * Marks held bookings whose time is up as expired. The database frees their seats itself (a trigger).
 * Safe to run any number of times, even at the same moment from several workers: each booking is
 * taken by exactly one run (`FOR UPDATE SKIP LOCKED`), and a booking that is no longer `held` is never touched.
 * Returns how many bookings were expired.
 */
export async function expireDueBookings(
  db: Database,
  redis: SeatsAnnouncer,
  logger: Logger,
  batchSize = 500,
): Promise<number> {
  let total = 0;
  for (;;) {
    // Ordered by event, so two runs always lock events in the same order and cannot wait for each other.
    const result = await db.execute<{ event_id: number }>(sql`
      with due as (
        select id from bookings
        where status = 'held' and expires_at <= clock_timestamp()
        order by event_id, id
        limit ${batchSize}
        for update skip locked
      )
      update bookings b set status = 'expired'
      from due where b.id = due.id
      returning b.event_id
    `);
    const eventIds = [...new Set(result.rows.map((row) => row.event_id))];
    for (const eventId of eventIds) {
      try {
        await announceSeats(db, redis, eventId);
      } catch (error) {
        logger.warn({ err: error instanceof Error ? error.message : String(error), eventId }, "could not announce free seats");
      }
    }
    total += result.rows.length;
    if (result.rows.length < batchSize) break;
  }
  if (total > 0) logger.info({ expired: total }, "expired bookings");
  return total;
}
