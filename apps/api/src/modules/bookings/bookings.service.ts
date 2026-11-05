import { createHash } from "node:crypto";
import { isSoldOutError, readPgError, type Database } from "@app/db";
import { ErrorCode, type ApiError, type BookingDto, type MyBookingDto, type MyBookingsResponse, type PublicUser } from "@app/shared";
import type { SeatsNotifier } from "../../infra/seats-notifier";
import { createAppError, notFound } from "../../lib/app-error";
import { toBookingDto, type BookingsRepository } from "./bookings.repository";

/** What to send back for a booking request: a status and a body, new or replayed. */
export interface CreateOutcome {
  status: number;
  body: BookingDto | ApiError;
  /** True when this is the saved answer to an earlier request with the same Idempotency-Key. */
  replayed: boolean;
}

export interface BookingsService {
  create: (input: { user: PublicUser; eventId: number; quantity: number; idempotencyKey: string }) => Promise<CreateOutcome>;
  confirm: (user: PublicUser, bookingId: string) => Promise<BookingDto>;
  cancel: (user: PublicUser, bookingId: string) => Promise<BookingDto>;
  listMine: (user: PublicUser) => Promise<MyBookingsResponse>;
  /** One of your own bookings. Someone else's looks like it does not exist. */
  getMine: (user: PublicUser, bookingId: string) => Promise<MyBookingDto>;
}

export interface BookingsServiceDeps {
  db: Database;
  repository: BookingsRepository;
  notifier: Pick<SeatsNotifier, "seatsChanged">;
  /** How long seats are held before the booking must be confirmed. */
  holdSeconds: number;
}

const FOREIGN_KEY_VIOLATION = "23503";

const noSuchBooking = () => notFound("There is no such booking.");

export function createBookingsService({
  db,
  repository,
  notifier,
  holdSeconds,
}: BookingsServiceDeps): BookingsService {
  return {
    async create({ user, eventId, quantity, idempotencyKey }) {
      // Same event + same quantity = same request. The key is tied to the user by the table's primary key.
      const requestHash = createHash("sha256").update(JSON.stringify({ eventId, quantity })).digest("hex");

      const outcome = await db.transaction(async (tx): Promise<CreateOutcome> => {
        const isFirst = await repository.claimKey(tx, user.id, idempotencyKey, requestHash);

        if (!isFirst) {
          const saved = await repository.readKey(tx, user.id, idempotencyKey);
          if (saved?.requestHash !== requestHash) {
            throw createAppError(
              422,
              ErrorCode.IDEMPOTENCY_KEY_REUSED,
              "This Idempotency-Key was already used for a different request. Use a new key.",
            );
          }
          if (saved.responseStatus === null) {
            throw createAppError(409, ErrorCode.REQUEST_IN_PROGRESS, "This request is still being processed. Try again in a moment.");
          }
          return { status: saved.responseStatus, body: saved.responseBody as BookingDto | ApiError, replayed: true };
        }

        try {
          // A nested transaction is a savepoint: if the seats run out, only this step is undone,
          // and the key (with the "sold out" answer) can still be saved.
          const row = await tx.transaction((inner) =>
            repository.insertHeld(inner, { userId: user.id, eventId, quantity, holdSeconds }),
          );
          const body = toBookingDto(row);
          await repository.storeResponse(tx, user.id, idempotencyKey, 201, body);
          return { status: 201, body, replayed: false };
        } catch (error) {
          if (readPgError(error)?.code === FOREIGN_KEY_VIOLATION) throw notFound("There is no such event.");
          if (!isSoldOutError(error)) throw error;

          // Read inside this transaction: asking for another connection while holding one can deadlock the pool.
          const available = await repository.seatsLeft(tx, eventId);
          const body: ApiError = {
            code: ErrorCode.SOLD_OUT,
            message:
              available === 0
                ? "Sorry, this event is sold out."
                : `Only ${available} ${available === 1 ? "seat is" : "seats are"} left.`,
            details: { available },
          };
          await repository.storeResponse(tx, user.id, idempotencyKey, 409, body);
          return { status: 409, body, replayed: false };
        }
      });

      if (!outcome.replayed && outcome.status === 201) notifier.seatsChanged(eventId);
      return outcome;
    },

    async confirm(user, bookingId) {
      const confirmed = await repository.confirm(db, bookingId, user.id);
      if (confirmed) return toBookingDto(confirmed);

      const existing = await repository.findOwned(db, bookingId, user.id);
      if (!existing) throw noSuchBooking();
      switch (existing.status) {
        case "confirmed":
          return toBookingDto(existing); // confirming twice is harmless
        case "cancelled":
          throw createAppError(409, ErrorCode.BOOKING_CANCELLED, "This booking was cancelled.");
        case "expired":
          throw createAppError(409, ErrorCode.BOOKING_EXPIRED, "The time to confirm this booking has run out.");
        case "held": {
          // Time is up but the worker has not marked it yet: do it now so the seats are free again.
          const expired = await repository.expireIfDue(db, bookingId, user.id);
          if (expired) notifier.seatsChanged(expired.eventId);
          throw createAppError(409, ErrorCode.BOOKING_EXPIRED, "The time to confirm this booking has run out.");
        }
      }
    },

    async cancel(user, bookingId) {
      const cancelled = await repository.cancel(db, bookingId, user.id);
      if (cancelled) {
        notifier.seatsChanged(cancelled.eventId);
        return toBookingDto(cancelled);
      }

      const existing = await repository.findOwned(db, bookingId, user.id);
      if (!existing) throw noSuchBooking();
      if (existing.status === "cancelled") return toBookingDto(existing); // cancelling twice is harmless
      throw createAppError(409, ErrorCode.BOOKING_EXPIRED, "This booking has already expired.");
    },

    listMine: (user) => repository.listForUser(user.id),

    async getMine(user, bookingId) {
      const found = await repository.findOneForUser(user.id, bookingId);
      if (!found) throw noSuchBooking();
      return found;
    },
  };
}
