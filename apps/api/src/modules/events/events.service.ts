import { createHash } from "node:crypto";
import {
  ErrorCode,
  availabilitySchema,
  citiesResponseSchema,
  eventSchema,
  eventsPageSchema,
  type Availability,
  type EventDto,
  type EventsPage,
  type ListEventsQuery,
  type UpdateEventBody,
} from "@app/shared";
import type { Cache, CachePolicy, Generation } from "../../infra/cache/two-level-cache";
import type { SeatsNotifier } from "../../infra/seats-notifier";
import { seatsCacheKey } from "../../infra/seats-notifier";
import { createAppError, notFound, validationFailed } from "../../lib/app-error";
import type { EventsRepository } from "./events.repository";
import { decodeCursor, encodeCursor, resolveDateRange, toTsQuery } from "./query-helpers";

export interface CacheTimings {
  l1TtlMs: number;
  l2TtlMs: number;
  negativeTtlMs: number;
  /** Free seats may be this old at most (the assignment says: 1 second). */
  availabilityTtlMs: number;
}

export interface EventsService {
  list: (query: ListEventsQuery) => Promise<EventsPage>;
  /** Null when there is no such event. */
  get: (id: number) => Promise<EventDto | null>;
  /** Null when there is no such event. */
  availability: (id: number) => Promise<Availability | null>;
  /** Free seats read from the database right now, skipping the one-second cache (for the live stream). */
  availabilityNow: (id: number) => Promise<Availability | null>;
  cities: () => Promise<string[]>;
  /** Admin edit. Refused (409) if the event changed since `body.version`. */
  update: (id: number, body: UpdateEventBody) => Promise<EventDto>;
}

export interface EventsServiceDeps {
  repository: EventsRepository;
  cache: Cache;
  /** Changes whenever any event changes; part of every cache key, so a change clears everything. */
  catalog: Generation;
  timings: CacheTimings;
  notifier: Pick<SeatsNotifier, "seatsChanged">;
  /** Called after a successful edit, e.g. to tell the web app to refresh its pages. */
  onUpdated?: (event: EventDto) => Promise<void> | void;
}

const hash = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 20);

export function createEventsService({ repository, cache, catalog, timings, notifier, onUpdated }: EventsServiceDeps): EventsService {
  const shared = { l1TtlMs: timings.l1TtlMs, l2TtlMs: timings.l2TtlMs, negativeTtlMs: timings.negativeTtlMs };
  const eventPolicy: CachePolicy<EventDto> = { schema: eventSchema, ...shared };
  const pagePolicy: CachePolicy<EventsPage> = { schema: eventsPageSchema, ...shared };
  const citiesPolicy: CachePolicy<string[]> = { schema: citiesResponseSchema, ...shared };
  // Seats change with every booking, so they stay in this process only and for a very short time.
  const availabilityPolicy: CachePolicy<Availability> = {
    schema: availabilitySchema,
    l1TtlMs: timings.availabilityTtlMs,
    l2TtlMs: 0,
    negativeTtlMs: timings.availabilityTtlMs,
  };

  const get = (id: number) =>
    cache.getOrLoad(`event:${catalog.current()}:${id}`, eventPolicy, async () => (await repository.findById(id)) ?? null);

  return {
    get,

    async list(query) {
      const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      if (query.cursor !== undefined && !after) throw validationFailed({ cursor: ["The cursor is not valid."] });

      const search = {
        city: query.city,
        tsQuery: query.q === undefined ? undefined : toTsQuery(query.q),
        ...resolveDateRange(query.from, query.to),
        after,
        limit: query.limit,
      };
      // Same search -> same key, whatever the order or case of the words in the URL.
      const key = `events:${catalog.current()}:${hash({ ...search, city: search.city?.toLowerCase() })}`;

      const page = await cache.getOrLoad(key, pagePolicy, async () => {
        const rows = await repository.list(search);
        const items = rows.slice(0, query.limit);
        const last = items.at(-1);
        const hasMore = rows.length > query.limit;
        return { items, nextCursor: hasMore && last ? encodeCursor({ startsAt: last.startsAt, id: last.id }) : null };
      });
      // The loader never returns null, so a page is always present.
      return page ?? { items: [], nextCursor: null };
    },

    async availability(id) {
      // Ask the (cached) event first: an id that does not exist never reaches the seats query.
      const event = await get(id);
      if (!event) return null;
      return cache.getOrLoad(seatsCacheKey(id), availabilityPolicy, async () => {
        const seats = await repository.seats(id);
        return seats
          ? { eventId: id, capacity: seats.capacity, available: Math.max(0, seats.capacity - seats.bookedSeats) }
          : null;
      });
    },

    async availabilityNow(id) {
      const seats = await repository.seats(id);
      return seats ? { eventId: id, capacity: seats.capacity, available: Math.max(0, seats.capacity - seats.bookedSeats) } : null;
    },

    async update(id, { version, ...patch }) {
      const result = await repository.update(id, version, patch);
      switch (result.kind) {
        case "missing":
          throw notFound("There is no such event.");
        case "conflict":
          throw createAppError(
            409,
            ErrorCode.VERSION_CONFLICT,
            "Someone else changed this event while you were editing it. Review the latest version and try again.",
            { details: { current: result.current } },
          );
        case "capacity_too_low":
          throw createAppError(
            409,
            ErrorCode.CAPACITY_TOO_LOW,
            `The capacity cannot be lower than the ${result.bookedSeats} seats already held or confirmed.`,
            { details: { bookedSeats: result.bookedSeats } },
          );
        case "updated": {
          // After the change is saved: clear every cache on every instance, tell seat watchers, tell the web app.
          await catalog.bump();
          if (patch.capacity !== undefined) notifier.seatsChanged(id);
          await onUpdated?.(result.event);
          return result.event;
        }
      }
    },

    async cities() {
      const cities = await cache.getOrLoad(`cities:${catalog.current()}`, citiesPolicy, () => repository.cities());
      return cities ?? [];
    },
  };
}
