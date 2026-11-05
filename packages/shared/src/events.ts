import { z } from "zod";

/** An event as the api sends it. Seats taken are not part of it: they change all the time. */
export const eventSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  city: z.string(),
  venue: z.string(),
  startsAt: z.iso.datetime(),
  capacity: z.number().int().positive(),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
});
export type EventDto = z.infer<typeof eventSchema>;

export const eventsPageSchema = z.object({
  items: z.array(eventSchema),
  /** Pass it back as `cursor` to get the next page; null on the last page. */
  nextCursor: z.string().nullable(),
});
export type EventsPage = z.infer<typeof eventsPageSchema>;

export const citiesResponseSchema = z.array(z.string());

export const availabilitySchema = z.object({
  eventId: z.number().int().positive(),
  capacity: z.number().int().positive(),
  /** Seats nobody holds or has confirmed. */
  available: z.number().int().min(0),
});
export type Availability = z.infer<typeof availabilitySchema>;

/** A blank value in the URL (`?city=`) means "not given". */
const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const dateOrDateTime = z.union([z.iso.datetime({ offset: true }), z.iso.date()], {
  error: "must be a date like 2026-12-31 or a date and time like 2026-12-31T18:00:00Z",
});

export const listEventsQuerySchema = z
  .object({
    city: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()),
    q: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()),
    /** Events starting at or after this moment. A plain date means the start of that day (UTC). */
    from: z.preprocess(blankToUndefined, dateOrDateTime.optional()),
    /** Events starting at or before this moment. A plain date includes that whole day (UTC). */
    to: z.preprocess(blankToUndefined, dateOrDateTime.optional()),
    cursor: z.preprocess(blankToUndefined, z.string().max(500).optional()),
    limit: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(50).default(20)),
  })
  .refine((value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), {
    path: ["to"],
    message: "The end date must not be before the start date.",
  });
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;

export const MAX_EVENT_ID = 2_147_483_647;

/** `GET /events/12` -> 12. Anything that is not a plain positive whole number is not an event id. */
export function parseEventId(raw: string): number | undefined {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return undefined;
  const id = Number(raw);
  return id <= MAX_EVENT_ID ? id : undefined;
}

export const updateEventBodySchema = z
  .strictObject({
    /** The version the editor saw. If the event changed since, the update is refused (409). */
    version: z.number().int().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(5000).optional(),
    capacity: z.number().int().min(1).max(1_000_000).optional(),
  })
  .refine((value) => value.title !== undefined || value.description !== undefined || value.capacity !== undefined, {
    message: "Change at least one of title, description or capacity.",
  });
export type UpdateEventBody = z.infer<typeof updateEventBodySchema>;

/** Names shared by every program that clears the caches (api, worker). */
export const CACHE_GENERATION_CHANNEL = "cache:generation";
export const CATALOG_GENERATION = "catalog";
export const generationKey = (name: string): string => `gen:${name}`;

/** The api says "an event was edited, look at the outbox now" here; the worker listens. */
export const OUTBOX_WAKE_CHANNEL = "outbox:wake";
