import "server-only";
import { citiesResponseSchema, eventSchema, eventsPageSchema, type EventDto, type EventsPage } from "@app/shared";
import { cacheLife, cacheTag } from "next/cache";
import { apiCall, apiCallOrNull } from "@/shared/api/api-client";

/**
 * Public data, cached by Next.js with tags. Nothing here knows who is asking: no cookies, no visitor
 * address, so one cached copy serves everyone, and the api does not count these calls against a visitor.
 *
 * The worker clears these tags (through /internal/revalidate) right after an event is edited, and the
 * admin form clears them itself, so a change shows up within moments. `cacheLife` is only the longest
 * a copy may live if no one clears it.
 */
const LIFETIME = { stale: 30, revalidate: 300, expire: 3600 } as const;

export const eventTag = (id: number) => `event:${id}`;
export const EVENTS_TAG = "events";
export const CITIES_TAG = "cities";

export async function getEvent(id: number): Promise<EventDto | null> {
  "use cache";
  cacheLife(LIFETIME);
  cacheTag(eventTag(id));
  return apiCallOrNull(`/events/${id}`, eventSchema);
}

export interface EventListQuery {
  city?: string | undefined;
  q?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export async function getEventsPage(query: EventListQuery): Promise<EventsPage> {
  "use cache";
  cacheLife(LIFETIME);
  cacheTag(EVENTS_TAG);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  return apiCall(`/events?${params}`, eventsPageSchema);
}

export async function getCities(): Promise<string[]> {
  "use cache";
  cacheLife(LIFETIME);
  cacheTag(CITIES_TAG);
  return apiCall("/cities", citiesResponseSchema);
}

/** Ids of the events that start soonest: the ones worth building ahead of time. */
export async function getNearestEventIds(count: number): Promise<number[]> {
  const page = await getEventsPage({ limit: count });
  return page.items.map((event) => event.id);
}
