import { z } from "zod";

export const bookingStatusSchema = z.enum(["held", "confirmed", "cancelled", "expired"]);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;

export const bookingSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  eventId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(4),
  status: bookingStatusSchema,
  /** When a held booking stops holding its seats. */
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type BookingDto = z.infer<typeof bookingSchema>;

export const createBookingBodySchema = z.strictObject({
  quantity: z.number().int().min(1).max(4),
});
export type CreateBookingBody = z.infer<typeof createBookingBodySchema>;

/** A booking with the event it is for, as shown on "my bookings". */
export const myBookingSchema = bookingSchema.extend({
  event: z.object({
    title: z.string(),
    city: z.string(),
    venue: z.string(),
    startsAt: z.iso.datetime(),
  }),
});
export type MyBookingDto = z.infer<typeof myBookingSchema>;

export const myBookingsResponseSchema = z.object({
  /** Newest first, at most 100. A held booking whose time is up is shown as "expired". */
  items: z.array(myBookingSchema),
  /** Held (still in time) plus confirmed bookings: the number in the page header. */
  activeCount: z.number().int().min(0),
});
export type MyBookingsResponse = z.infer<typeof myBookingsResponseSchema>;

/** Sent by the client once per intent to book, so a retry cannot book twice. */
export const idempotencyKeySchema = z
  .string({ error: "The Idempotency-Key header is required." })
  .regex(/^[A-Za-z0-9_.:-]{8,128}$/, "The Idempotency-Key must be 8-128 letters, digits, or . _ : -");

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const DEFAULT_HOLD_SECONDS = 600;

/** `/bookings/<id>` where id is not a UUID is simply not a booking. */
export const isBookingId = (raw: string): boolean => z.uuid().safeParse(raw).success;

/** Free seats channel: the api and the worker publish here, SSE listeners subscribe. */
export const availabilityChannel = (eventId: number): string => `availability:${eventId}`;
export const AVAILABILITY_CHANNEL_PATTERN = "availability:*";
