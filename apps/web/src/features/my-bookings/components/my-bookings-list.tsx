"use client";

import type { MyBookingDto } from "@app/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { useBookingsCounter } from "@/features/booking";
import { formatEventDate } from "@/features/event";
import { callApi } from "@/shared/api/browser-api";
import { Alert, AlertDescription } from "@/shared/ui/alert";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card, CardContent } from "@/shared/ui/card";

const isActive = (booking: MyBookingDto) => booking.status === "held" || booking.status === "confirmed";

export function MyBookingsList({ items }: { items: MyBookingDto[] }) {
  const router = useRouter();
  const counter = useBookingsCounter();
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  // The list as it should look right now: a booking being cancelled is already gone.
  const [shown, removeAtOnce] = useOptimistic<MyBookingDto[], string>(items, (current, id) => current.filter((b) => b.id !== id));

  const cancel = (booking: MyBookingDto) => {
    setFailure(null);
    startTransition(async () => {
      removeAtOnce(booking.id);
      if (isActive(booking)) counter.countAtOnce(-1);
      const result = await callApi(`/bookings/${booking.id}`, { method: "DELETE" });
      if (!result.ok) {
        // Leaving the transition without a refresh puts the booking back; say why.
        setFailure(`${booking.event.title}: ${result.message}`);
        router.refresh();
        return;
      }
      router.refresh();
    });
  };

  if (shown.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground" role="status">
        You have no bookings yet. <Link href="/" className="underline">Find an event</Link>.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {failure && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>The booking was not cancelled. {failure}</AlertDescription>
        </Alert>
      )}
      <ul className="space-y-3">
        {shown.map((booking) => (
          <li key={booking.id}>
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-medium">
                    <Link href={`/events/${booking.eventId}`} className="hover:underline">
                      {booking.event.title}
                    </Link>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {booking.quantity} {booking.quantity === 1 ? "ticket" : "tickets"} · {booking.event.city} · {formatEventDate(booking.event.startsAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={booking.status === "confirmed" ? "default" : "secondary"}>{booking.status}</Badge>
                  {booking.status === "held" && (
                    <Button asChild size="sm">
                      <Link href={`/checkout/${booking.id}`}>Pay and confirm</Link>
                    </Button>
                  )}
                  {isActive(booking) && (
                    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => cancel(booking)}>
                      Cancel
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
