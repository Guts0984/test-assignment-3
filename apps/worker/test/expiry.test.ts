import { bookings, events, users } from "@app/db";
import { availabilityChannel } from "@app/shared";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { expireDueBookings } from "../src/jobs/expire-bookings";
import { createLogger } from "../src/logger";
import { createWorld, sleep, until, type TestWorld } from "./helpers/env";

let world: TestWorld;
const logger = createLogger("silent");

beforeEach(async () => {
  world = await createWorld();
});
afterEach(async () => {
  await world.close();
});

const past = (seconds: number) => new Date(Date.now() - seconds * 1000);
const future = (seconds: number) => new Date(Date.now() + seconds * 1000);

async function makeUser(): Promise<string> {
  const [row] = await world.db.insert(users).values({ email: `u${Math.random()}@example.com`, passwordHash: "x" }).returning();
  if (!row) throw new Error("no user");
  return row.id;
}
async function makeEvent(capacity: number): Promise<number> {
  const [row] = await world.db
    .insert(events)
    .values({ title: "Expiry", description: "d", city: "Expiryville", venue: "v", startsAt: new Date("2031-01-01T10:00:00Z"), capacity })
    .returning();
  if (!row) throw new Error("no event");
  return row.id;
}
async function hold(userId: string, eventId: number, quantity: number, expiresAt: Date, status: "held" | "confirmed" | "cancelled" = "held") {
  const [row] = await world.db.insert(bookings).values({ userId, eventId, quantity, status, expiresAt }).returning();
  if (!row) throw new Error("no booking");
  return row;
}
const statusOf = async (id: string) => (await world.db.select().from(bookings).where(eq(bookings.id, id)))[0]?.status;
const bookedSeats = async (eventId: number) => (await world.db.select().from(events).where(eq(events.id, eventId)))[0]?.bookedSeats;

describe("expiring bookings (assignment check 16)", () => {
  it("expires held bookings whose time is up, frees their seats, and touches nothing else", async () => {
    const [user, eventId] = [await makeUser(), await makeEvent(50)];
    const due = await hold(user, eventId, 3, past(5));
    const alsoDue = await hold(user, eventId, 2, past(1));
    const stillTime = await hold(user, eventId, 4, future(300));
    const confirmedLongAgo = await hold(user, eventId, 1, past(500), "confirmed");
    const cancelled = await hold(user, eventId, 1, past(500), "cancelled");
    expect(await bookedSeats(eventId)).toBe(3 + 2 + 4 + 1);

    const expired = await expireDueBookings(world.db, world.redis, logger);

    expect(expired).toBe(2);
    expect(await statusOf(due.id)).toBe("expired");
    expect(await statusOf(alsoDue.id)).toBe("expired");
    expect(await statusOf(stillTime.id)).toBe("held");
    expect(await statusOf(confirmedLongAgo.id)).toBe("confirmed");
    expect(await statusOf(cancelled.id)).toBe("cancelled");
    expect(await bookedSeats(eventId)).toBe(4 + 1); // the held-in-time and the confirmed one still count
  });

  it("running it again does nothing more", async () => {
    const [user, eventId] = [await makeUser(), await makeEvent(50)];
    await hold(user, eventId, 3, past(5));
    expect(await expireDueBookings(world.db, world.redis, logger)).toBe(1);
    expect(await expireDueBookings(world.db, world.redis, logger)).toBe(0);
    expect(await expireDueBookings(world.db, world.redis, logger)).toBe(0);
    expect(await bookedSeats(eventId)).toBe(0); // not below zero: seats were freed once
  });

  it("a booking that is not due yet is left alone until it is", async () => {
    const [user, eventId] = [await makeUser(), await makeEvent(10)];
    const soon = await hold(user, eventId, 1, future(1));
    expect(await expireDueBookings(world.db, world.redis, logger)).toBe(0);
    expect(await statusOf(soon.id)).toBe("held");
    await sleep(1200);
    expect(await expireDueBookings(world.db, world.redis, logger)).toBe(1);
    expect(await statusOf(soon.id)).toBe("expired");
  });

  it("announces the new number of free seats to everyone watching, once per event", async () => {
    const [user, a, b] = [await makeUser(), await makeEvent(10), await makeEvent(20)];
    await hold(user, a, 4, past(5));
    await hold(user, a, 2, past(5));
    await hold(user, b, 4, past(5));

    const listener = new Redis(inject("redisUrl"));
    const heard: { eventId: number; capacity: number; available: number }[] = [];
    listener.on("message", (_channel, message) => heard.push(JSON.parse(message)));
    await listener.subscribe(availabilityChannel(a), availabilityChannel(b));

    await expireDueBookings(world.db, world.redis, logger);
    await until(() => heard.length >= 2, 2000, "two announcements");
    await sleep(100);
    listener.disconnect();

    expect(heard).toHaveLength(2);
    expect(heard.find((m) => m.eventId === a)).toEqual({ eventId: a, capacity: 10, available: 10 });
    expect(heard.find((m) => m.eventId === b)).toEqual({ eventId: b, capacity: 20, available: 20 });
  });

  it("says nothing when nothing expired", async () => {
    const [user, eventId] = [await makeUser(), await makeEvent(10)];
    await hold(user, eventId, 1, future(300));
    const listener = new Redis(inject("redisUrl"));
    let heard = 0;
    listener.on("message", () => (heard += 1));
    await listener.subscribe(availabilityChannel(eventId));
    await expireDueBookings(world.db, world.redis, logger);
    await sleep(150);
    listener.disconnect();
    expect(heard).toBe(0);
  });

  it("handles more bookings than fit in one batch", async () => {
    const [user, eventId] = [await makeUser(), await makeEvent(100_000)];
    await world.db.insert(bookings).values(Array.from({ length: 1200 }, () => ({ userId: user, eventId, quantity: 1, status: "held" as const, expiresAt: past(5) })));
    expect(await bookedSeats(eventId)).toBe(1200);

    expect(await expireDueBookings(world.db, world.redis, logger, 500)).toBe(1200);
    expect(await bookedSeats(eventId)).toBe(0);
    const left = await world.db.select().from(bookings).where(eq(bookings.status, "held"));
    expect(left.filter((b) => b.eventId === eventId)).toHaveLength(0);
  });

  it("two workers expiring at the same moment: every booking is expired exactly once, no deadlock, seats exact", async () => {
    const user = await makeUser();
    const ids = await Promise.all(Array.from({ length: 30 }, () => makeEvent(1000)));
    const rows = ids.flatMap((eventId) => Array.from({ length: 20 }, () => ({ userId: user, eventId, quantity: 2, status: "held" as const, expiresAt: past(5) })));
    // Mix them up, so the two runs would meet the events in different orders if they could.
    rows.sort(() => Math.random() - 0.5);
    await world.db.insert(bookings).values(rows);

    const results = await Promise.all([
      expireDueBookings(world.db, world.redis, logger, 25),
      expireDueBookings(world.db, world.redis, logger, 40),
      expireDueBookings(world.db, world.redis, logger, 60),
    ]);

    expect(results.reduce((a, b) => a + b, 0)).toBe(30 * 20);
    for (const eventId of ids) expect(await bookedSeats(eventId)).toBe(0);
  });

  it("an expired booking cannot come back: the database refuses to move it to 'held' again", async () => {
    const [user, eventId] = [await makeUser(), await makeEvent(10)];
    const booking = await hold(user, eventId, 1, past(5));
    await expireDueBookings(world.db, world.redis, logger);
    await expect(world.db.update(bookings).set({ status: "held" }).where(eq(bookings.id, booking.id))).rejects.toThrow();
  });
});

describe("the worker expires bookings by itself", () => {
  it("a booking is expired within moments after its time is up, with nobody asking", async () => {
    const [user, eventId] = [await makeUser(), await makeEvent(10)];
    const booking = await hold(user, eventId, 2, future(1));
    await world.startWorker({ expiryIntervalMs: 100 });

    expect(await statusOf(booking.id)).toBe("held");
    await until(async () => (await statusOf(booking.id)) === "expired", 4000, "the booking to expire");
    expect(await bookedSeats(eventId)).toBe(0);
  });

  it("two workers on the same queue expire everything once", async () => {
    const [user, eventId] = [await makeUser(), await makeEvent(1000)];
    await world.db.insert(bookings).values(Array.from({ length: 100 }, () => ({ userId: user, eventId, quantity: 1, status: "held" as const, expiresAt: past(5) })));
    const prefix = "shared-expiry";
    await world.startWorker({ prefix, expiryIntervalMs: 100 });
    await world.startWorker({ prefix, expiryIntervalMs: 100 });
    await until(async () => (await bookedSeats(eventId)) === 0, 4000, "all seats to be free");
    const rows = (await world.db.select().from(bookings)).filter((b) => b.eventId === eventId);
    expect(rows.every((b) => b.status === "expired")).toBe(true);
  });
});
