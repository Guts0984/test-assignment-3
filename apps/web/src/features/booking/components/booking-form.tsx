"use client";

import type { BookingDto } from "@app/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { useSeats } from "@/features/availability";
import { callApi } from "@/shared/api/browser-api";
import { Alert, AlertDescription } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import { createBookingIntent } from "../lib/intent";
import { bookingFailureMessage, isUncertain } from "../lib/messages";
import { useBookingsCounter } from "./bookings-provider";

const MAX_TICKETS = 4;

export function BookingForm({ eventId, loggedIn }: { eventId: number; loggedIn: boolean }) {
  const router = useRouter();
  const seats = useSeats();
  const counter = useBookingsCounter();
  const [quantity, setQuantity] = useState(1);
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  // One key per attempt: a double click, or a retry after a dropped connection, is the same booking.
  const intent = useRef(createBookingIntent());

  if (!loggedIn) {
    return (
      <p className="text-sm">
        <Link href={`/login?next=${encodeURIComponent(`/events/${eventId}`)}`} className="font-medium underline">
          Log in
        </Link>{" "}
        or{" "}
        <Link href={`/register?next=${encodeURIComponent(`/events/${eventId}`)}`} className="font-medium underline">
          create an account
        </Link>{" "}
        to book seats.
      </p>
    );
  }

  const soldOut = seats.available === 0;
  const tooMany = seats.available !== null && quantity > seats.available;

  const submit = () => {
    if (pending) return; // a second click while the first is on its way does nothing
    const key = intent.current.key();
    setFailure(null);
    startTransition(async () => {
      // Shown at once; taken back automatically when this transition ends, unless the real numbers have arrived.
      seats.showAtOnce(-quantity);
      counter.countAtOnce(1);

      const result = await callApi<BookingDto>(`/events/${eventId}/bookings`, {
        method: "POST",
        body: { quantity },
        headers: { "Idempotency-Key": key },
      });

      if (result.ok) {
        intent.current.finish();
        await seats.refresh();
        router.push(`/checkout/${result.data.id}`);
        router.refresh();
        return;
      }
      // The attempt is over unless we do not know what happened; then the same key makes a retry safe.
      if (!isUncertain(result.status)) intent.current.finish();
      setFailure(bookingFailureMessage(result));
      if (result.status === 409) await seats.refresh();
    });
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      aria-describedby={failure ? "booking-error" : undefined}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="booking-quantity">Tickets</Label>
          <select
            id="booking-quantity"
            className="h-8 w-24 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            value={quantity}
            onChange={(event) => setQuantity(Number(event.target.value))}
            disabled={pending}
          >
            {Array.from({ length: MAX_TICKETS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={pending || soldOut || tooMany} aria-busy={pending}>
          {pending ? "Booking…" : soldOut ? "Sold out" : "Book"}
        </Button>
      </div>
      {tooMany && !soldOut && (
        <p className="text-sm text-muted-foreground" role="status">
          Only {seats.available} {seats.available === 1 ? "seat is" : "seats are"} left. Choose fewer tickets.
        </p>
      )}
      {failure && (
        <Alert variant="destructive" id="booking-error" role="alert">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
