"use client";

import { eventsPageSchema, type EventDto, type EventsPage } from "@app/shared";
import { useRef, useState } from "react";
import { EventCard } from "@/features/event";
import { callApi } from "@/shared/api/browser-api";
import { createLatestOnly } from "@/shared/lib/latest-only";
import { Alert, AlertDescription } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { filtersToQueryString, type CatalogFilters } from "../lib/filters";

/**
 * The first page comes from the server (and its cache); "Show more" asks for the next ones.
 * The page that renders this gives it a `key` made from the filters, so changing a filter starts it
 * afresh: an answer to an earlier search can never be added to the list of a later one.
 */
export function EventList({ initial, filters }: { initial: EventsPage; filters: CatalogFilters }) {
  const [items, setItems] = useState<EventDto[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useRef(createLatestOnly());

  const showMore = async () => {
    if (!cursor || loading) return;
    const ticket = latest.current.next();
    setLoading(true);
    setFailure(null);
    const query = filtersToQueryString(filters);
    const result = await callApi<unknown>(`/events${query}${query ? "&" : "?"}cursor=${encodeURIComponent(cursor)}&limit=20`);
    if (!latest.current.isCurrent(ticket)) return; // an older request must not overwrite a newer one
    setLoading(false);
    if (!result.ok) {
      setFailure(result.message);
      return;
    }
    const page = eventsPageSchema.safeParse(result.data);
    if (!page.success) {
      setFailure("We could not read the answer. Please try again.");
      return;
    }
    setItems((current) => [...current, ...page.data.items.filter((event) => !current.some((c) => c.id === event.id))]);
    setCursor(page.data.nextCursor);
  };

  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground" role="status">
        No events match these filters. Try another city, other dates or a different search.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((event) => (
          <li key={event.id} className="relative">
            <EventCard event={event} />
          </li>
        ))}
      </ul>
      {failure && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {cursor && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" onClick={showMore} disabled={loading} aria-busy={loading}>
            {loading ? "Loading…" : "Show more"}
          </Button>
        </div>
      )}
    </div>
  );
}
