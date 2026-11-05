import { parseEventId, availabilitySchema } from "@app/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SeatsDisplay, SeatsProvider } from "@/features/availability";
import { getSessionUser } from "@/features/auth/server";
import { BookingForm } from "@/features/booking";
import { EventDetails } from "@/features/event";
import { getEvent, getNearestEventIds } from "@/features/event/server";
import { apiCall } from "@/shared/api/api-client";
import { getRequestContext } from "@/shared/api/request-context";
import { logger } from "@/shared/logger";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { Skeleton } from "@/shared/ui/skeleton";

/** The 30 events that start soonest are built ahead of time; any other event is built when first asked for. */
export async function generateStaticParams() {
  const ids = await getNearestEventIds(30);
  return ids.map((id) => ({ id: String(id) }));
}

export async function generateMetadata(props: PageProps<"/events/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const eventId = parseEventId(id);
  const event = eventId === undefined ? null : await getEvent(eventId).catch(() => null);
  return { title: event ? event.title : "Event not found" };
}

export default async function EventPage(props: PageProps<"/events/[id]">) {
  const { id } = await props.params;
  const eventId = parseEventId(id);
  if (eventId === undefined) notFound();

  // Looked up before anything is sent to the browser, so a missing event is answered with a real 404.
  const event = await getEvent(eventId);
  if (!event) notFound();

  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-8">
      <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← All events
      </Link>
      <EventDetails event={event} />
      {/* Free seats and the booking form depend on the moment and on who is looking, so they load apart from the cached text above. */}
      <Suspense fallback={<SeatsSkeleton />}>
        <Seats eventId={event.id} capacity={event.capacity} />
      </Suspense>
    </main>
  );
}

/** Reads the seats and the visitor right now. If either fails, the rest of the page is untouched. */
async function Seats({ eventId, capacity }: { eventId: number; capacity: number }) {
  const context = await getRequestContext();
  const [initialAvailable, user] = await Promise.all([
    apiCall(`/events/${eventId}/availability`, availabilitySchema, context).then(
      (a) => a.available,
      (error: unknown) => {
        logger.warn({ requestId: context.requestId, eventId, err: error instanceof Error ? error.message : String(error) }, "could not read free seats");
        return null;
      },
    ),
    getSessionUser().catch(() => null),
  ]);

  return (
    <SeatsProvider eventId={eventId} capacity={capacity} initialAvailable={initialAvailable}>
      <Card>
        <CardHeader>
          <CardTitle>Tickets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <SeatsDisplay />
          <BookingForm eventId={eventId} loggedIn={user !== null} />
        </CardContent>
      </Card>
      {/* Only for administrators. It sits here, with the parts that depend on who is looking, so it can never end up in the shared cached copy of the page. */}
      {user?.role === "admin" && (
        <Button asChild variant="outline">
          <Link href={`/admin/events/${eventId}`}>Edit event</Link>
        </Button>
      )}
    </SeatsProvider>
  );
}

function SeatsSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading tickets">
      <CardContent className="space-y-4 pt-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-8 w-64" />
      </CardContent>
    </Card>
  );
}
