"use client";

import Link from "next/link";
import { createContext, use, useOptimistic, type ReactNode } from "react";
import { Badge } from "@/shared/ui/badge";

interface BookingsContextValue {
  /** Bookings made or cancelled a moment ago that the server has not counted yet (+1 / -1 each). */
  pendingChange: number;
  /** Changes the number in the header at once. Lasts until the surrounding transition ends. */
  countAtOnce: (change: number) => void;
}

const BookingsContext = createContext<BookingsContextValue | null>(null);

export function useBookingsCounter(): BookingsContextValue {
  const value = use(BookingsContext);
  if (!value) throw new Error("useBookingsCounter needs a BookingsProvider above it");
  return value;
}

/** Sits above the whole site, so the header and the page share the same "bookings in progress" number. */
export function BookingsProvider({ children }: { children: ReactNode }) {
  const [pendingChange, countAtOnce] = useOptimistic<number, number>(0, (current, change) => current + change);
  return <BookingsContext value={{ pendingChange, countAtOnce }}>{children}</BookingsContext>;
}

/** The number next to "My bookings": what the server counted, plus what is happening right now. */
export function ActiveBookingsLink({ serverCount }: { serverCount: number }) {
  const { pendingChange } = useBookingsCounter();
  const count = Math.max(0, serverCount + pendingChange);
  return (
    <Link href="/me/bookings" className="inline-flex items-center gap-2 text-sm font-medium hover:underline">
      My bookings
      <Badge variant="secondary" aria-label={`${count} active ${count === 1 ? "booking" : "bookings"}`} data-testid="active-bookings">
        {count}
      </Badge>
    </Link>
  );
}
