import { bookings, events, idempotencyKeys, type BookingRow, type Database } from "@app/db";
import type { BookingDto, BookingStatus, MyBookingDto } from "@app/shared";
import { and, desc, eq, sql } from "drizzle-orm";

/** A database or an open transaction: the queries below run on either. */
export type Executor = Pick<Database, "select" | "insert" | "update">;

export const toBookingDto = (row: BookingRow): BookingDto => ({
  id: row.id,
  userId: row.userId,
  eventId: row.eventId,
  quantity: row.quantity,
  status: row.status,
  expiresAt: row.expiresAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
});

export interface IdempotencyRecord {
  requestHash: string;
  responseStatus: number | null;
  responseBody: unknown;
}

export interface BookingsRepository {
  insertHeld: (
    exec: Executor,
    input: { userId: string; eventId: number; quantity: number; holdSeconds: number },
  ) => Promise<BookingRow>;
  findOwned: (exec: Executor, id: string, userId: string) => Promise<BookingRow | undefined>;
  /** held and still in time -> confirmed. Undefined if the booking was not in that state. */
  confirm: (exec: Executor, id: string, userId: string) => Promise<BookingRow | undefined>;
  /** held, held too long -> expired (frees the seats now, without waiting for the worker). */
  expireIfDue: (exec: Executor, id: string, userId: string) => Promise<BookingRow | undefined>;
  /** held or confirmed -> cancelled. */
  cancel: (exec: Executor, id: string, userId: string) => Promise<BookingRow | undefined>;
  /** Free seats of an event, read through `exec` so it never needs a second connection. */
  seatsLeft: (exec: Executor, eventId: number) => Promise<number>;
  listForUser: (userId: string) => Promise<{ items: MyBookingDto[]; activeCount: number }>;
  findOneForUser: (userId: string, bookingId: string) => Promise<MyBookingDto | undefined>;
  /** Writes the key if it is new (true). If it exists, waits for a running first request, then returns false. */
  claimKey: (exec: Executor, userId: string, key: string, requestHash: string) => Promise<boolean>;
  readKey: (exec: Executor, userId: string, key: string) => Promise<IdempotencyRecord | undefined>;
  storeResponse: (exec: Executor, userId: string, key: string, status: number, body: unknown) => Promise<void>;
}

const LIST_LIMIT = 100;

export function createBookingsRepository(db: Database): BookingsRepository {
  return {
    async insertHeld(exec, { userId, eventId, quantity, holdSeconds }) {
      const [row] = await exec
        .insert(bookings)
        .values({
          userId,
          eventId,
          quantity,
          status: "held",
          // The database's own clock, read when the row is written, so the hold is exactly this long.
          expiresAt: sql`clock_timestamp() + ${holdSeconds} * interval '1 second'`,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return row;
    },

    async findOwned(exec, id, userId) {
      const [row] = await exec
        .select()
        .from(bookings)
        .where(and(eq(bookings.id, id), eq(bookings.userId, userId)))
        .limit(1);
      return row;
    },

    async confirm(exec, id, userId) {
      const [row] = await exec
        .update(bookings)
        .set({ status: "confirmed" })
        .where(
          and(
            eq(bookings.id, id),
            eq(bookings.userId, userId),
            eq(bookings.status, "held"),
            sql`${bookings.expiresAt} > clock_timestamp()`,
          ),
        )
        .returning();
      return row;
    },

    async expireIfDue(exec, id, userId) {
      const [row] = await exec
        .update(bookings)
        .set({ status: "expired" })
        .where(
          and(
            eq(bookings.id, id),
            eq(bookings.userId, userId),
            eq(bookings.status, "held"),
            sql`${bookings.expiresAt} <= clock_timestamp()`,
          ),
        )
        .returning();
      return row;
    },

    async cancel(exec, id, userId) {
      const [row] = await exec
        .update(bookings)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(bookings.id, id),
            eq(bookings.userId, userId),
            sql`${bookings.status} in ('held', 'confirmed')`,
          ),
        )
        .returning();
      return row;
    },

    async seatsLeft(exec, eventId) {
      const [row] = await exec
        .select({ capacity: events.capacity, bookedSeats: events.bookedSeats })
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);
      return row ? Math.max(0, row.capacity - row.bookedSeats) : 0;
    },

    async listForUser(userId) {
      // A held booking whose time is up is shown as expired even before the worker has marked it.
      const shownStatus = sql<BookingStatus>`case when ${bookings.status} = 'held' and ${bookings.expiresAt} <= clock_timestamp() then 'expired' else ${bookings.status} end`;
      const rows = await db
        .select({
          booking: bookings,
          shownStatus,
          title: events.title,
          city: events.city,
          venue: events.venue,
          startsAt: events.startsAt,
        })
        .from(bookings)
        .innerJoin(events, eq(events.id, bookings.eventId))
        .where(eq(bookings.userId, userId))
        .orderBy(desc(bookings.createdAt), desc(bookings.id))
        .limit(LIST_LIMIT);

      const [counted] = await db
        .select({
          active: sql<number>`count(*) filter (where ${bookings.status} = 'confirmed' or (${bookings.status} = 'held' and ${bookings.expiresAt} > clock_timestamp()))::int`,
        })
        .from(bookings)
        .where(eq(bookings.userId, userId));

      return {
        items: rows.map((row) => ({
          ...toBookingDto(row.booking),
          status: row.shownStatus,
          event: { title: row.title, city: row.city, venue: row.venue, startsAt: row.startsAt.toISOString() },
        })),
        activeCount: counted?.active ?? 0,
      };
    },

    async findOneForUser(userId, bookingId) {
      const shownStatus = sql<BookingStatus>`case when ${bookings.status} = 'held' and ${bookings.expiresAt} <= clock_timestamp() then 'expired' else ${bookings.status} end`;
      const [row] = await db
        .select({ booking: bookings, shownStatus, title: events.title, city: events.city, venue: events.venue, startsAt: events.startsAt })
        .from(bookings)
        .innerJoin(events, eq(events.id, bookings.eventId))
        .where(and(eq(bookings.id, bookingId), eq(bookings.userId, userId)))
        .limit(1);
      if (!row) return undefined;
      return {
        ...toBookingDto(row.booking),
        status: row.shownStatus,
        event: { title: row.title, city: row.city, venue: row.venue, startsAt: row.startsAt.toISOString() },
      };
    },

    async claimKey(exec, userId, key, requestHash) {
      // If the same key is being handled right now by another request, this waits until that one
      // has committed or given up, then reports "already there". The database does the queuing.
      const inserted = await exec
        .insert(idempotencyKeys)
        .values({ userId, key, requestHash })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });
      return inserted.length > 0;
    },

    async readKey(exec, userId, key) {
      const [row] = await exec
        .select({
          requestHash: idempotencyKeys.requestHash,
          responseStatus: idempotencyKeys.responseStatus,
          responseBody: idempotencyKeys.responseBody,
        })
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)))
        .limit(1);
      return row;
    },

    async storeResponse(exec, userId, key, status, body) {
      await exec
        .update(idempotencyKeys)
        .set({ responseStatus: status, responseBody: body })
        .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    },
  };
}
