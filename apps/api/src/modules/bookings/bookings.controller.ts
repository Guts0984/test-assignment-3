import { createBookingBodySchema, idempotencyKeySchema, isBookingId, parseEventId, IDEMPOTENCY_KEY_HEADER } from "@app/shared";
import type { RequestHandler, Response } from "express";
import { notFound, validationFailed } from "../../lib/app-error";
import { getCurrentUser } from "../../middleware/auth";
import { validated } from "../../middleware/validate";
import type { BookingsService } from "./bookings.service";

export interface BookingsController {
  create: RequestHandler;
  confirm: RequestHandler;
  cancel: RequestHandler;
  listMine: RequestHandler;
  getOne: RequestHandler;
}

/** The routes run requireUser first, so a user is always there; this keeps the types honest. */
function currentUser(res: Response) {
  const user = getCurrentUser(res);
  if (!user) throw new Error("requireUser must run before this handler");
  return user;
}

const bookingIdFrom = (raw: string | string[] | undefined): string => {
  if (typeof raw !== "string" || !isBookingId(raw)) throw notFound("There is no such booking.");
  return raw;
};

export function createBookingsController(service: BookingsService): BookingsController {
  return {
    create: validated({ body: createBookingBodySchema }, async ({ body }, req, res) => {
      const eventId = parseEventId(typeof req.params["id"] === "string" ? req.params["id"] : "");
      if (eventId === undefined) throw notFound("There is no such event.");

      const key = idempotencyKeySchema.safeParse(req.get(IDEMPOTENCY_KEY_HEADER));
      if (!key.success) {
        throw validationFailed({ [IDEMPOTENCY_KEY_HEADER]: [key.error.issues[0]?.message ?? "The Idempotency-Key header is not valid."] });
      }

      const outcome = await service.create({
        user: currentUser(res),
        eventId,
        quantity: body.quantity,
        idempotencyKey: key.data,
      });
      if (outcome.replayed) res.setHeader("Idempotent-Replay", "true");
      res.status(outcome.status).json(outcome.body);
    }),

    confirm: async (req, res) => {
      res.json(await service.confirm(currentUser(res), bookingIdFrom(req.params["id"])));
    },

    cancel: async (req, res) => {
      res.json(await service.cancel(currentUser(res), bookingIdFrom(req.params["id"])));
    },

    getOne: async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(await service.getMine(currentUser(res), bookingIdFrom(req.params["id"])));
    },

    listMine: async (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(await service.listMine(currentUser(res)));
    },
  };
}
