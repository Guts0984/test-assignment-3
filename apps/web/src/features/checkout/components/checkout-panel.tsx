"use client";

import type { BookingDto, MyBookingDto } from "@app/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition } from "react";
import { useBookingsCounter } from "@/features/booking";
import { formatEventDate } from "@/features/event";
import { callApi } from "@/shared/api/browser-api";
import { Alert, AlertDescription } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/shared/ui/card";
import { formatRemaining, remainingMs, serverNowFromBrowser } from "../lib/countdown";

// One clock for the page, ticking every second. Reading it through useSyncExternalStore keeps React happy.
const clock = {
  listeners: new Set<() => void>(),
  now: 0,
  timer: undefined as ReturnType<typeof setInterval> | undefined,
};
const browserNow = () => Date.now();
function subscribeToClock(listener: () => void) {
  clock.listeners.add(listener);
  if (clock.timer === undefined) {
    clock.timer = setInterval(() => {
      clock.now = browserNow();
      for (const l of clock.listeners) l();
    }, 1000);
  }
  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size === 0 && clock.timer !== undefined) {
      clearInterval(clock.timer);
      clock.timer = undefined;
    }
  };
}
const clockSnapshot = () => (clock.now === 0 ? (clock.now = browserNow()) : clock.now);

export function CheckoutPanel({ booking, serverNowMs }: { booking: MyBookingDto; serverNowMs: number }) {
  const router = useRouter();
  const counter = useBookingsCounter();
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const [status, setStatus] = useState(booking.status);
  // How far this browser's clock is from the server's, fixed when the page was made.
  const [offsetMs] = useState(() => serverNowMs - browserNow());

  const browserTime = useSyncExternalStore(subscribeToClock, clockSnapshot, () => serverNowMs - offsetMs);
  const left = remainingMs(Date.parse(booking.expiresAt), serverNowFromBrowser(browserTime, offsetMs));
  const timeIsUp = status === "held" && left === 0;
  const canAct = status === "held" && !timeIsUp;

  const act = (kind: "confirm" | "cancel") =>
    startTransition(async () => {
      setFailure(null);
      if (kind === "cancel") counter.countAtOnce(-1);
      const result =
        kind === "confirm"
          ? await callApi<BookingDto>(`/bookings/${booking.id}/confirm`, { method: "POST" })
          : await callApi<BookingDto>(`/bookings/${booking.id}`, { method: "DELETE" });
      if (result.ok) {
        setStatus(result.data.status);
        router.push("/me/bookings");
        router.refresh();
        return;
      }
      if (result.error.code === "BOOKING_EXPIRED") setStatus("expired");
      if (result.error.code === "BOOKING_CANCELLED") setStatus("cancelled");
      setFailure(result.message);
      router.refresh();
    });

  return (
    <Card className="mx-auto w-full max-w-lg">
      <CardHeader>
        <CardTitle className="text-xl">Complete your booking</CardTitle>
        <CardDescription>
          {booking.quantity} {booking.quantity === 1 ? "ticket" : "tickets"} for{" "}
          <Link href={`/events/${booking.eventId}`} className="underline">
            {booking.event.title}
          </Link>{" "}
          · {booking.event.city} · {formatEventDate(booking.event.startsAt)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canAct && (
          <div role="timer" aria-live="off" className="rounded-lg bg-muted p-4 text-center">
            <p className="text-sm text-muted-foreground">Your seats are held for</p>
            <p className="text-4xl font-semibold tabular-nums" data-testid="countdown">
              {formatRemaining(left)}
            </p>
          </div>
        )}
        {timeIsUp || status === "expired" ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>The time to confirm has run out and the seats were released. You can book again from the event page.</AlertDescription>
          </Alert>
        ) : status === "confirmed" ? (
          <Alert role="status">
            <AlertDescription>This booking is confirmed. See you at the event!</AlertDescription>
          </Alert>
        ) : status === "cancelled" ? (
          <Alert role="status">
            <AlertDescription>This booking was cancelled.</AlertDescription>
          </Alert>
        ) : null}
        {failure && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="gap-3">
        <Button type="button" onClick={() => act("confirm")} disabled={!canAct || pending} aria-busy={pending}>
          Confirm
        </Button>
        <Button type="button" variant="outline" onClick={() => act("cancel")} disabled={!canAct || pending}>
          Cancel booking
        </Button>
        {!canAct && (
          <Button asChild variant="link">
            <Link href={`/events/${booking.eventId}`}>Back to the event</Link>
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
