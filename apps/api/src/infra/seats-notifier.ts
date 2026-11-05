import { events, type Database } from "@app/db";
import { availabilityChannel } from "@app/shared";
import { eq } from "drizzle-orm";
import type { Cache } from "./cache/two-level-cache";
import type { Logger } from "./logger";
import type { Redis } from "./redis";

/** The cache key of an event's free seats (see events.service). */
export const seatsCacheKey = (eventId: number): string => `seats:${eventId}`;

export interface SeatsNotifier {
  /**
   * Call after anything that changes free seats (a booking, a cancellation, a capacity edit).
   * This process forgets its cached number at once; everyone listening (live seat streams on
   * every instance) is told the new number shortly after. Several changes in a burst become one message.
   */
  seatsChanged: (eventId: number) => void;
  /** Sends what is still waiting and stops. */
  close: () => Promise<void>;
}

export interface SeatsNotifierOptions {
  db: Database;
  redis: Pick<Redis, "publish">;
  cache: Pick<Cache, "forgetLocal">;
  logger: Logger;
  /** How long to gather a burst of changes before telling anyone. */
  delayMs?: number;
}

export function createSeatsNotifier({ db, redis, cache, logger, delayMs = 20 }: SeatsNotifierOptions): SeatsNotifier {
  const waiting = new Map<number, NodeJS.Timeout>();

  async function send(eventId: number): Promise<void> {
    try {
      const [row] = await db
        .select({ capacity: events.capacity, bookedSeats: events.bookedSeats })
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);
      if (!row) return;
      const message = { eventId, capacity: row.capacity, available: Math.max(0, row.capacity - row.bookedSeats) };
      await redis.publish(availabilityChannel(eventId), JSON.stringify(message));
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error), eventId }, "could not announce free seats");
    }
  }

  return {
    seatsChanged(eventId) {
      cache.forgetLocal(seatsCacheKey(eventId));
      if (waiting.has(eventId)) return; // the message already scheduled will carry the latest number
      const timer = setTimeout(() => {
        waiting.delete(eventId);
        void send(eventId);
      }, delayMs);
      waiting.set(eventId, timer);
    },

    async close() {
      const ids = [...waiting.keys()];
      for (const timer of waiting.values()) clearTimeout(timer);
      waiting.clear();
      await Promise.all(ids.map(send));
    },
  };
}
