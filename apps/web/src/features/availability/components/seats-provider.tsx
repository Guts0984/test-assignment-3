"use client";

import { availabilitySchema } from "@app/shared";
import { createContext, use, useCallback, useEffect, useOptimistic, useState, type ReactNode } from "react";
import { callApi } from "@/shared/api/browser-api";
import { reconnectDelayMs } from "../lib/backoff";

export type SeatsStatus = "live" | "connecting" | "reconnecting";

interface SeatsContextValue {
  /** Free seats as the visitor should see them: the real number, plus any booking in progress. Null if unknown. */
  available: number | null;
  capacity: number;
  status: SeatsStatus;
  /** Shows a change at once (negative = seats being taken). It lasts until the surrounding transition ends. */
  showAtOnce: (change: number) => void;
  /** Asks the api for the real number now. */
  refresh: () => Promise<void>;
}

const SeatsContext = createContext<SeatsContextValue | null>(null);

export function useSeats(): SeatsContextValue {
  const value = use(SeatsContext);
  if (!value) throw new Error("useSeats needs a SeatsProvider above it");
  return value;
}

export interface SeatsProviderProps {
  eventId: number;
  capacity: number;
  /** The number the server saw when it rendered the page; null if it could not find out. */
  initialAvailable: number | null;
  children: ReactNode;
}

/**
 * Keeps the free-seat number of one event up to date from the live stream. If the connection drops it
 * reconnects with growing pauses, and the page keeps showing the last number meanwhile.
 */
export function SeatsProvider({ eventId, capacity, initialAvailable, children }: SeatsProviderProps) {
  const [real, setReal] = useState<number | null>(initialAvailable);
  const [status, setStatus] = useState<SeatsStatus>("connecting");
  const [shown, showAtOnce] = useOptimistic<number | null, number>(real, (current, change) =>
    current === null ? null : Math.max(0, current + change),
  );

  useEffect(() => {
    let attempt = 0;
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      source = new EventSource(`/api/events/${eventId}/stream`);
      source.addEventListener("open", () => {
        attempt = 0;
        setStatus("live");
      });
      source.addEventListener("availability", (message) => {
        const parsed = availabilitySchema.safeParse(JSON.parse((message as MessageEvent<string>).data));
        if (parsed.success && parsed.data.eventId === eventId) setReal(parsed.data.available);
      });
      source.addEventListener("error", () => {
        // The browser would retry by itself, but at a fixed pace. We close and retry with growing pauses.
        source?.close();
        if (stopped) return;
        setStatus("reconnecting");
        retryTimer = setTimeout(connect, reconnectDelayMs(attempt));
        attempt += 1;
      });
    };
    connect();

    return () => {
      stopped = true;
      source?.close();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [eventId]);

  const refresh = useCallback(async () => {
    const result = await callApi<unknown>(`/events/${eventId}/availability`);
    if (!result.ok) return;
    const parsed = availabilitySchema.safeParse(result.data);
    if (parsed.success) setReal(parsed.data.available);
  }, [eventId]);

  return <SeatsContext value={{ available: shown, capacity, status, showAtOnce, refresh }}>{children}</SeatsContext>;
}
