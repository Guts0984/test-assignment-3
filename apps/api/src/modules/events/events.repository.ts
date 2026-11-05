import { events, isSoldOutError, type Database } from "@app/db";
import type { EventDto } from "@app/shared";
import { and, asc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { getRequestId } from "../../infra/request-context";
import type { DateRange, PageCursor } from "./query-helpers";

export interface EventSearch extends DateRange {
  city?: string;
  /** A ready Postgres tsquery (see toTsQuery). */
  tsQuery?: string;
  after?: PageCursor;
  limit: number;
}

export type EventPatch = { title?: string; description?: string; capacity?: number };

export type UpdateResult =
  | { kind: "updated"; event: EventDto }
  | { kind: "missing" }
  /** The event changed since the editor loaded it; `current` is what is saved now. */
  | { kind: "conflict"; current: EventDto }
  /** The new capacity is below the seats already held or confirmed. */
  | { kind: "capacity_too_low"; bookedSeats: number };

export interface EventsRepository {
  /** One page, oldest start first. Returns up to `limit + 1` rows so the caller can tell if more follow. */
  list: (search: EventSearch) => Promise<EventDto[]>;
  findById: (id: number) => Promise<EventDto | undefined>;
  cities: () => Promise<string[]>;
  seats: (id: number) => Promise<{ capacity: number; bookedSeats: number } | undefined>;
  /** Changes the event only if it is still at `version`. The database raises the version itself. */
  update: (id: number, version: number, patch: EventPatch) => Promise<UpdateResult>;
}

// What the api shows of an event. The search column and the seats taken are left out on purpose.
const columns = {
  id: events.id,
  title: events.title,
  description: events.description,
  city: events.city,
  venue: events.venue,
  startsAt: events.startsAt,
  capacity: events.capacity,
  version: events.version,
  updatedAt: events.updatedAt,
};

type Row = { [K in keyof typeof columns]: (typeof columns)[K]["_"]["data"] };

const toDto = (row: Row): EventDto => ({
  ...row,
  startsAt: row.startsAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export function createEventsRepository(db: Database): EventsRepository {
  async function findById(id: number): Promise<EventDto | undefined> {
    const [row] = await db.select(columns).from(events).where(eq(events.id, id)).limit(1);
    return row ? toDto(row) : undefined;
  }

  async function seats(id: number) {
    const [row] = await db
      .select({ capacity: events.capacity, bookedSeats: events.bookedSeats })
      .from(events)
      .where(eq(events.id, id))
      .limit(1);
    return row;
  }

  return {
    async list({ city, tsQuery, from, toExclusive, after, limit }) {
      const conditions: SQL[] = [];
      if (city !== undefined && city !== "") conditions.push(sql`lower(${events.city}) = ${city.toLowerCase()}`);
      if (from) conditions.push(gte(events.startsAt, from));
      if (toExclusive) conditions.push(lt(events.startsAt, toExclusive));
      if (tsQuery) conditions.push(sql`${events.searchVector} @@ to_tsquery('simple', ${tsQuery})`);
      if (after) {
        // Keyset pagination: everything strictly after the last event of the previous page.
        conditions.push(sql`(${events.startsAt}, ${events.id}) > (${new Date(after.startsAt)}, ${after.id})`);
      }

      const rows = await db
        .select(columns)
        .from(events)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(events.startsAt), asc(events.id))
        .limit(limit + 1);
      return rows.map(toDto);
    },

    findById,

    async cities() {
      const rows = await db.selectDistinct({ city: events.city }).from(events).orderBy(asc(events.city));
      return rows.map((row) => row.city);
    },

    seats,

    async update(id, version, patch) {
      try {
        // One transaction: note which request is making the change (the database copies it onto the
        // outbox row), then change the row only if it is still at `version`, in a single statement,
        // so two editors cannot both win.
        const row = await db.transaction(async (tx) => {
          const requestId = getRequestId();
          if (requestId) await tx.execute(sql`select set_config('app.request_id', ${requestId}, true)`);
          const [updated] = await tx
            .update(events)
            .set(patch)
            .where(and(eq(events.id, id), eq(events.version, version)))
            .returning(columns);
          return updated;
        });
        if (row) return { kind: "updated", event: toDto(row) };
      } catch (error) {
        // The database refuses a capacity below the seats already taken.
        if (!isSoldOutError(error)) throw error;
        return { kind: "capacity_too_low", bookedSeats: (await seats(id))?.bookedSeats ?? 0 };
      }

      const current = await findById(id);
      return current ? { kind: "conflict", current } : { kind: "missing" };
    },
  };
}
