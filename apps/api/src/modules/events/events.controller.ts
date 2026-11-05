import { listEventsQuerySchema, parseEventId, updateEventBodySchema } from "@app/shared";
import type { Availability } from "@app/shared";
import type { RequestHandler } from "express";
import { notFound } from "../../lib/app-error";
import { validated } from "../../middleware/validate";
import type { SeatsHub } from "../../infra/seats-hub";
import type { EventsService } from "./events.service";

export interface EventsController {
  list: RequestHandler;
  get: RequestHandler;
  availability: RequestHandler;
  cities: RequestHandler;
  update: RequestHandler;
  stream: RequestHandler;
}

/** An id that is not a plain positive whole number is simply not an event: 404, no database involved. */
const idFrom = (raw: string | string[] | undefined): number => {
  const id = parseEventId(typeof raw === "string" ? raw : "");
  if (id === undefined) throw notFound("There is no such event.");
  return id;
};

export interface StreamOptions {
  hub: SeatsHub;
  /** How often a comment line keeps the connection from being closed as idle. */
  heartbeatMs: number;
}

const format = (update: Availability) => `event: availability\ndata: ${JSON.stringify(update)}\n\n`;

export function createEventsController(service: EventsService, { hub, heartbeatMs }: StreamOptions): EventsController {
  return {
    list: validated({ query: listEventsQuerySchema }, async ({ query }, _req, res) => {
      res.json(await service.list(query));
    }),

    get: async (req, res) => {
      const event = await service.get(idFrom(req.params["id"]));
      if (!event) throw notFound("There is no such event.");
      res.json(event);
    },

    availability: async (req, res) => {
      const availability = await service.availability(idFrom(req.params["id"]));
      if (!availability) throw notFound("There is no such event.");
      res.json(availability);
    },

    update: validated({ body: updateEventBodySchema }, async ({ body }, req, res) => {
      res.json(await service.update(idFrom(req.params["id"]), body));
    }),

    stream: async (req, res) => {
      const id = idFrom(req.params["id"]);
      if (!(await service.availabilityNow(id))) throw notFound("There is no such event.");

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // tells nginx not to hold the stream back
      });
      res.write("retry: 3000\n\n"); // the browser reconnects after 3 s if the connection drops

      // Say a number only when it differs from the last one sent: viewers do not need the same news twice.
      let lastSent = "";
      const write = (update: Availability) => {
        const text = format(update);
        if (text === lastSent) return;
        lastSent = text;
        res.write(text);
      };

      // Listen first, then read the current number, so no change can slip between the two.
      let changedWhileStarting = false;
      let started = false;
      const unsubscribe = hub.subscribe(id, {
        send: (update) => {
          if (started) write(update);
          else changedWhileStarting = true;
        },
        close: () => res.end(),
      });
      const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });

      const first = await service.availabilityNow(id);
      if (first) write(first);
      started = true;
      if (changedWhileStarting) {
        const latest = await service.availabilityNow(id);
        if (latest) write(latest);
      }
    },

    cities: async (_req, res) => {
      res.json(await service.cities());
    },
  };
}
