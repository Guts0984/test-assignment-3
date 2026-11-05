import { bookingSchema, createBookingBodySchema, myBookingSchema, myBookingsResponseSchema } from "@app/shared";
import { Router } from "express";
import { z } from "zod";
import { errorResponse, type RouteDoc } from "../../infra/openapi/build-document";
import { requireSameOrigin, requireUser } from "../../middleware/auth";
import type { BookingsController } from "./bookings.controller";

export function createBookingsRouter(controller: BookingsController): Router {
  const router = Router();
  router.post("/events/:id/bookings", requireSameOrigin, requireUser, controller.create);
  router.post("/bookings/:id/confirm", requireSameOrigin, requireUser, controller.confirm);
  router.delete("/bookings/:id", requireSameOrigin, requireUser, controller.cancel);
  router.get("/me/bookings", requireUser, controller.listMine);
  router.get("/bookings/:id", requireUser, controller.getOne);
  return router;
}

const eventIdParam = z.object({ id: z.string().regex(/^[1-9]\d*$/).meta({ description: "Event id" }) });
const bookingIdParam = z.object({ id: z.uuid().meta({ description: "Booking id" }) });
const keyHeader = z.object({
  "Idempotency-Key": z.string().meta({ description: "A new random value (e.g. a UUID) for each attempt to book. Repeating a request with the same key returns the first answer and never books twice." }),
});

export const bookingsRoutes: RouteDoc[] = [
  {
    method: "post",
    path: "/events/:id/bookings",
    summary: "Hold seats for 10 minutes. Needs an Idempotency-Key header",
    tags: ["Bookings"],
    requiresSession: true,
    request: { params: eventIdParam, headers: keyHeader, body: createBookingBodySchema },
    responses: {
      201: { description: "Seats are held. Confirm before expiresAt", schema: bookingSchema },
      400: errorResponse("Invalid quantity, or missing/invalid Idempotency-Key"),
      401: errorResponse("Not logged in"),
      404: errorResponse("No such event"),
      409: errorResponse("Not enough seats (details.available says how many are left)"),
      422: errorResponse("This Idempotency-Key was used for a different request"),
      429: errorResponse("Too many requests"),
    },
  },
  {
    method: "post",
    path: "/bookings/:id/confirm",
    summary: "Confirm a held booking (only your own, only before it expires)",
    tags: ["Bookings"],
    requiresSession: true,
    request: { params: bookingIdParam },
    responses: {
      200: { description: "Confirmed (also if it already was)", schema: bookingSchema },
      401: errorResponse("Not logged in"),
      404: errorResponse("No such booking"),
      409: errorResponse("The booking expired or was cancelled"),
    },
  },
  {
    method: "delete",
    path: "/bookings/:id",
    summary: "Cancel a held or confirmed booking (only your own); its seats become free",
    tags: ["Bookings"],
    requiresSession: true,
    request: { params: bookingIdParam },
    responses: {
      200: { description: "Cancelled (also if it already was)", schema: bookingSchema },
      401: errorResponse("Not logged in"),
      404: errorResponse("No such booking"),
      409: errorResponse("The booking already expired"),
    },
  },
  {
    method: "get",
    path: "/bookings/:id",
    summary: "One of your bookings, with its event",
    tags: ["Bookings"],
    requiresSession: true,
    request: { params: bookingIdParam },
    responses: {
      200: { description: "The booking", schema: myBookingSchema },
      401: errorResponse("Not logged in"),
      404: errorResponse("No such booking, or not yours"),
    },
  },
  {
    method: "get",
    path: "/me/bookings",
    summary: "Your bookings, newest first, and the number of active ones",
    tags: ["Bookings"],
    requiresSession: true,
    responses: {
      200: { description: "Your bookings", schema: myBookingsResponseSchema },
      401: errorResponse("Not logged in"),
    },
  },
];
