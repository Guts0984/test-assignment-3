import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isSoldOutError, pgErrorCodes, readPgError } from "../src/pg-errors";
import { bookings, events, users } from "../src/schema";
import { clearAll, eventInput, futureDate, startTestDb, type TestDb } from "./helpers";

let t: TestDb;

beforeAll(async () => {
  t = await startTestDb(50);
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await clearAll(t);
});

async function createUser(email = "u@example.com") {
  const [user] = await t.db.insert(users).values({ email, passwordHash: "x" }).returning();
  if (!user) throw new Error("user not created");
  return user;
}

async function createEvent(capacity: number) {
  const [event] = await t.db.insert(events).values(eventInput({ capacity })).returning();
  if (!event) throw new Error("event not created");
  return event;
}

const hold = (userId: string, eventId: number, quantity = 1) =>
  t.db.insert(bookings).values({ userId, eventId, quantity, expiresAt: futureDate(10) }).returning();

describe("no overselling", () => {
  it("300 concurrent single-seat bookings for 20 seats: exactly 20 succeed, 280 are sold out", async () => {
    const user = await createUser();
    const event = await createEvent(20);

    const results = await Promise.allSettled(Array.from({ length: 300 }, () => hold(user.id, event.id)));

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(succeeded).toHaveLength(20);
    expect(failed).toHaveLength(280);
    expect(failed.every((r) => isSoldOutError(r.reason))).toBe(true);

    const [row] = await t.db.select().from(events).where(eq(events.id, event.id));
    expect(row?.bookedSeats).toBe(20);
  });

  it("mixed quantities never exceed capacity and booked_seats equals the sum of active bookings", async () => {
    const user = await createUser();
    const event = await createEvent(25);

    await Promise.allSettled(
      Array.from({ length: 120 }, (_, i) => hold(user.id, event.id, (i % 4) + 1)),
    );

    const [row] = await t.db.select().from(events).where(eq(events.id, event.id));
    const sum = await t.pool.query<{ total: string }>(
      "SELECT COALESCE(SUM(quantity), 0) AS total FROM bookings WHERE event_id = $1 AND status IN ('held','confirmed')",
      [event.id],
    );
    expect(row?.bookedSeats).toBeLessThanOrEqual(25);
    expect(Number(sum.rows[0]?.total)).toBe(row?.bookedSeats);
  });

  it("rejects a quantity outside 1-4", async () => {
    const user = await createUser();
    const event = await createEvent(20);
    const error = await hold(user.id, event.id, 5).catch((e: unknown) => e);
    expect(readPgError(error)?.code).toBe(pgErrorCodes.checkViolation);
    expect(isSoldOutError(error)).toBe(false);
  });

  it("cancelling or expiring a booking returns its seats", async () => {
    const user = await createUser();
    const event = await createEvent(10);
    const [a] = await hold(user.id, event.id, 3);
    const [b] = await hold(user.id, event.id, 2);
    if (!a || !b) throw new Error("bookings not created");

    const seats = async () =>
      (await t.db.select().from(events).where(eq(events.id, event.id)))[0]?.bookedSeats;
    expect(await seats()).toBe(5);

    await t.db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, a.id));
    expect(await seats()).toBe(2);

    await t.db.update(bookings).set({ status: "expired" }).where(eq(bookings.id, b.id));
    expect(await seats()).toBe(0);
  });

  it("confirming keeps the seats taken", async () => {
    const user = await createUser();
    const event = await createEvent(10);
    const [a] = await hold(user.id, event.id, 4);
    if (!a) throw new Error("booking not created");

    await t.db.update(bookings).set({ status: "confirmed" }).where(eq(bookings.id, a.id));
    const [row] = await t.db.select().from(events).where(eq(events.id, event.id));
    expect(row?.bookedSeats).toBe(4);
  });

  it("capacity cannot be lowered below the seats already taken", async () => {
    const user = await createUser();
    const event = await createEvent(10);
    await hold(user.id, event.id, 4);

    const error = await t.db
      .update(events)
      .set({ capacity: 3 })
      .where(eq(events.id, event.id))
      .catch((e: unknown) => e);
    expect(isSoldOutError(error)).toBe(true);
  });
});

describe("booking status rules", () => {
  it.each([
    ["expired", "held"],
    ["cancelled", "held"],
    ["cancelled", "confirmed"],
    ["expired", "confirmed"],
  ] as const)("does not allow %s -> %s", async (from, to) => {
    const user = await createUser();
    const event = await createEvent(10);
    const [booking] = await hold(user.id, event.id);
    if (!booking) throw new Error("booking not created");

    await t.db.update(bookings).set({ status: from }).where(eq(bookings.id, booking.id));
    const error = await t.db
      .update(bookings)
      .set({ status: to })
      .where(eq(bookings.id, booking.id))
      .catch((e: unknown) => e);
    expect(readPgError(error)?.code).toBe(pgErrorCodes.invalidBookingTransition);
  });

  it("allows held -> confirmed -> cancelled", async () => {
    const user = await createUser();
    const event = await createEvent(10);
    const [booking] = await hold(user.id, event.id);
    if (!booking) throw new Error("booking not created");

    await t.db.update(bookings).set({ status: "confirmed" }).where(eq(bookings.id, booking.id));
    await t.db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, booking.id));
    const [row] = await t.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row?.status).toBe("cancelled");
  });
});

describe("event version and outbox", () => {
  it("booking traffic does not change version, updated_at or the outbox", async () => {
    const user = await createUser();
    const event = await createEvent(10);
    await hold(user.id, event.id, 2);

    const [row] = await t.db.select().from(events).where(eq(events.id, event.id));
    expect(row?.version).toBe(1);
    expect(row?.updatedAt.getTime()).toBe(event.updatedAt.getTime());
    const outbox = await t.pool.query("SELECT 1 FROM outbox");
    expect(outbox.rowCount).toBe(0);
  });

  it("a content change bumps the version once and records it in the outbox", async () => {
    const event = await createEvent(10);

    await t.db.update(events).set({ title: "New title" }).where(eq(events.id, event.id));
    await t.db.update(events).set({ capacity: 15 }).where(eq(events.id, event.id));

    const [row] = await t.db.select().from(events).where(eq(events.id, event.id));
    expect(row?.version).toBe(3);

    const outbox = await t.pool.query<{ event_version: number }>(
      "SELECT event_version FROM outbox WHERE event_id = $1 ORDER BY id",
      [event.id],
    );
    expect(outbox.rows.map((r) => r.event_version)).toEqual([2, 3]);
  });

  it("an update that changes nothing does not bump the version", async () => {
    const event = await createEvent(10);
    await t.db.update(events).set({ title: event.title }).where(eq(events.id, event.id));
    const [row] = await t.db.select().from(events).where(eq(events.id, event.id));
    expect(row?.version).toBe(1);
  });

  it("raw SQL edits are recorded too", async () => {
    const event = await createEvent(10);
    await t.pool.query("UPDATE events SET description = 'changed by hand' WHERE id = $1", [event.id]);
    const outbox = await t.pool.query("SELECT 1 FROM outbox WHERE event_id = $1", [event.id]);
    expect(outbox.rowCount).toBe(1);
  });
});

describe("full-text search column", () => {
  it("matches title words by prefix", async () => {
    await t.db.insert(events).values(eventInput({ title: "Midnight Orchestra in Concert" }));
    const result = await t.db.execute(
      sql`SELECT id FROM events WHERE search_vector @@ to_tsquery('simple', 'orch:*')`,
    );
    expect(result.rows).toHaveLength(1);
  });
});
