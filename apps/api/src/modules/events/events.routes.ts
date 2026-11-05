import {
  availabilitySchema,
  citiesResponseSchema,
  eventSchema,
  eventsPageSchema,
  listEventsQuerySchema,
  updateEventBodySchema,
} from "@app/shared";
import { Router } from "express";
import { z } from "zod";
import { errorResponse, type RouteDoc } from "../../infra/openapi/build-document";
import { requireAdmin, requireSameOrigin } from "../../middleware/auth";
import type { EventsController } from "./events.controller";

export function createEventsRouter(controller: EventsController): Router {
  const router = Router();
  router.get("/events", controller.list);
  router.get("/events/:id", controller.get);
  router.get("/events/:id/availability", controller.availability);
  router.get("/events/:id/stream", controller.stream);
  router.get("/cities", controller.cities);
  router.patch("/events/:id", requireSameOrigin, requireAdmin, controller.update);
  return router;
}

const idParam = z.object({ id: z.string().regex(/^[1-9]\d*$/).meta({ description: "Event id, a positive whole number" }) });

export const eventsRoutes: RouteDoc[] = [
  {
    method: "get",
    path: "/events",
    summary: "List events (filters, text search, cursor pagination, oldest start first)",
    tags: ["Events"],
    request: { query: listEventsQuerySchema },
    responses: {
      200: { description: "A page of events", schema: eventsPageSchema },
      400: errorResponse("A filter or the cursor is not valid"),
      429: errorResponse("Too many requests"),
    },
  },
  {
    method: "get",
    path: "/events/:id",
    summary: "One event",
    tags: ["Events"],
    request: { params: idParam },
    responses: {
      200: { description: "The event", schema: eventSchema },
      404: errorResponse("No such event"),
      429: errorResponse("Too many requests"),
    },
  },
  {
    method: "get",
    path: "/events/:id/availability",
    summary: "Free seats right now (never older than 1 second)",
    tags: ["Events"],
    request: { params: idParam },
    responses: {
      200: { description: "Free seats", schema: availabilitySchema },
      404: errorResponse("No such event"),
      429: errorResponse("Too many requests"),
    },
  },
  {
    method: "get",
    path: "/events/:id/stream",
    summary: "Live free seats (Server-Sent Events): the current number first, then one message per change",
    tags: ["Events"],
    request: { params: idParam },
    responses: {
      200: { description: "A text/event-stream. Each `availability` event carries {eventId, capacity, available}" },
      404: errorResponse("No such event"),
      429: errorResponse("Too many requests"),
    },
  },
  {
    method: "patch",
    path: "/events/:id",
    summary: "Edit title, description or capacity (administrators only). Needs the version you saw",
    tags: ["Events"],
    requiresSession: true,
    request: { params: idParam, body: updateEventBodySchema },
    responses: {
      200: { description: "The event as saved, with its new version", schema: eventSchema },
      400: errorResponse("Invalid field, or no change given"),
      401: errorResponse("Not logged in"),
      403: errorResponse("Not an administrator"),
      404: errorResponse("No such event"),
      409: errorResponse("Version conflict (details.current is the saved event) or capacity below the seats taken"),
    },
  },
  {
    method: "get",
    path: "/cities",
    summary: "Cities that have events, for the filter",
    tags: ["Events"],
    responses: { 200: { description: "City names, sorted", schema: citiesResponseSchema } },
  },
];
