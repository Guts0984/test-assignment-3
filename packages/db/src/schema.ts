import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const timestamptz = () => timestamp({ withTimezone: true, mode: "date" });

export const userRole = pgEnum("user_role", ["user", "admin"]);
export const bookingStatus = pgEnum("booking_status", [
  "held",
  "confirmed",
  "cancelled",
  "expired",
]);

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    passwordHash: text().notNull(),
    role: userRole().notNull().default("user"),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`)],
);

export const events = pgTable(
  "events",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    title: text().notNull(),
    description: text().notNull(),
    city: text().notNull(),
    venue: text().notNull(),
    startsAt: timestamptz().notNull(),
    capacity: integer().notNull(),
    bookedSeats: integer().notNull().default(0),
    version: integer().notNull().default(1),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
    searchVector: tsvector().generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(description, '')), 'B') || setweight(to_tsvector('simple', coalesce(venue, '')), 'C')`,
    ),
  },
  (t) => [
    check("events_capacity_positive", sql`${t.capacity} > 0`),
    check(
      "events_booked_seats_within_capacity",
      sql`${t.bookedSeats} >= 0 AND ${t.bookedSeats} <= ${t.capacity}`,
    ),
    index("events_starts_at_id_idx").on(t.startsAt, t.id),
    index("events_city_starts_at_id_idx").on(t.city, t.startsAt, t.id),
    index("events_search_idx").using("gin", t.searchVector),
  ],
);

export const bookings = pgTable(
  "bookings",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    eventId: integer()
      .notNull()
      .references(() => events.id),
    quantity: integer().notNull(),
    status: bookingStatus().notNull().default("held"),
    expiresAt: timestamptz().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    check("bookings_quantity_range", sql`${t.quantity} BETWEEN 1 AND 4`),
    index("bookings_user_created_idx").on(t.userId, t.createdAt.desc(), t.id),
    index("bookings_event_idx").on(t.eventId),
    // The worker scans only unexpired-looking held rows.
    index("bookings_held_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'held'`),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id),
    key: text().notNull(),
    /** Hash of method + path + body, to tell a retry from a different request. */
    requestHash: text().notNull(),
    /** Null while the first request is still running. */
    responseStatus: integer(),
    responseBody: jsonb(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.key] }),
    check(
      "idempotency_keys_key_length",
      sql`char_length(${t.key}) BETWEEN 1 AND 255`,
    ),
  ],
);

export const outbox = pgTable(
  "outbox",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    eventId: integer()
      .notNull()
      .references(() => events.id),
    eventVersion: integer().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    dispatchedAt: timestamptz(),
  },
  (t) => [
    uniqueIndex("outbox_event_version_idx").on(t.eventId, t.eventVersion),
    index("outbox_pending_idx")
      .on(t.id)
      .where(sql`${t.dispatchedAt} IS NULL`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type BookingRow = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
export type BookingStatus = (typeof bookingStatus.enumValues)[number];
export type UserRole = (typeof userRole.enumValues)[number];
