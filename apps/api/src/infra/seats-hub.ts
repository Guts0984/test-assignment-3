import { AVAILABILITY_CHANNEL_PATTERN, availabilitySchema, type Availability } from "@app/shared";
import type { Cache } from "./cache/two-level-cache";
import type { Logger } from "./logger";
import type { Redis } from "./redis";
import { seatsCacheKey } from "./seats-notifier";

/** One open live-seats stream. */
export interface SeatsClient {
  send: (update: Availability) => void;
  /** End the stream politely. */
  close: () => void;
}

export interface SeatsHub {
  /** Starts sending updates for one event to `client`. Returns the function that stops it. */
  subscribe: (eventId: number, client: SeatsClient) => () => void;
  /** Ends every open stream (used when the server shuts down). */
  closeAll: () => void;
  /** Number of open streams, for tests and monitoring. */
  size: () => number;
  stop: () => Promise<void>;
}

export interface SeatsHubOptions {
  /** A connection of its own: one that listens cannot be used for anything else. */
  subscriber: Pick<Redis, "psubscribe" | "on" | "disconnect">;
  cache: Pick<Cache, "forgetLocal">;
  logger: Logger;
}

/**
 * Every api instance listens to "free seats changed" announcements in Redis and passes them to the
 * streams that are open on THIS instance. A booking made on any instance reaches viewers on all of them.
 */
export async function createSeatsHub({ subscriber, cache, logger }: SeatsHubOptions): Promise<SeatsHub> {
  const clients = new Map<number, Set<SeatsClient>>();

  subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
    const eventId = Number(channel.slice(channel.indexOf(":") + 1));
    if (!Number.isInteger(eventId)) return;
    try {
      const parsed = availabilitySchema.safeParse(JSON.parse(message));
      if (!parsed.success || parsed.data.eventId !== eventId) return; // not a message we know: ignore it
      cache.forgetLocal(seatsCacheKey(eventId)); // our own cached number is out of date now
      for (const client of clients.get(eventId) ?? []) {
        try {
          client.send(parsed.data);
        } catch (error) {
          logger.warn({ err: error instanceof Error ? error.message : String(error), eventId }, "could not send a seats update");
        }
      }
    } catch {
      // not JSON: ignore
    }
  });
  await subscriber.psubscribe(AVAILABILITY_CHANNEL_PATTERN);

  return {
    subscribe(eventId, client) {
      const forEvent = clients.get(eventId) ?? new Set<SeatsClient>();
      forEvent.add(client);
      clients.set(eventId, forEvent);
      return () => {
        forEvent.delete(client);
        if (forEvent.size === 0 && clients.get(eventId) === forEvent) clients.delete(eventId);
      };
    },

    closeAll() {
      for (const forEvent of [...clients.values()]) {
        for (const client of [...forEvent]) client.close();
      }
      clients.clear();
    },

    size: () => [...clients.values()].reduce((total, set) => total + set.size, 0),

    stop: async () => {
      subscriber.disconnect();
    },
  };
}
