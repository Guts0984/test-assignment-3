import { randomUUID } from "node:crypto";
import { bookings, events, idempotencyKeys, outbox, users } from "@app/db";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startStack, type Instance, type Stack } from "./helpers/stack";

let stack: Stack;
let apiOne: Instance;
let apiTwo: Instance;

beforeAll(async () => {
  stack = await startStack();
  apiOne = await stack.makeInstance();
  apiTwo = await stack.makeInstance();
});
afterAll(async () => {
  await stack.close();
});
beforeEach(async () => {
  await stack.db.delete(idempotencyKeys);
  await stack.db.delete(bookings);
  await stack.db.delete(outbox);
  await stack.db.delete(events);
  await stack.db.delete(users);
  await stack.redis.flushall();
});

const password = "correct-horse-1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const newKey = () => `key-${randomUUID()}`;

interface Person {
  id: string;
  email: string;
  cookie: string;
}

async function signUp(email: string, app: Express = stack.app): Promise<Person> {
  const res = await request(app).post("/auth/register").send({ email, password });
  if (res.status !== 201) throw new Error(`could not register ${email}: ${res.status}`);
  const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("sid="))?.split(";")[0] ?? "";
  return { id: res.body.id, email, cookie };
}

async function signUpAdmin(email = "admin@example.com"): Promise<Person> {
  const person = await signUp(email);
  await stack.db.update(users).set({ role: "admin" }).where(eq(users.id, person.id));
  return person;
}

async function addEvent(capacity = 20, overrides: Partial<typeof events.$inferInsert> = {}): Promise<number> {
  const [row] = await stack.db
    .insert(events)
    .values({ title: "Booking test", description: "d", city: "Bookville", venue: "v", startsAt: new Date("2031-06-01T10:00:00Z"), capacity, ...overrides })
    .returning();
  if (!row) throw new Error("no event");
  return row.id;
}

const book = (person: Person, eventId: number, quantity: number, key: string | null = newKey(), app: Express = stack.app) => {
  const req = request(app).post(`/events/${eventId}/bookings`).set("Cookie", person.cookie);
  if (key !== null) req.set("Idempotency-Key", key);
  return req.send({ quantity });
};
const confirm = (person: Person, bookingId: string, app: Express = stack.app) =>
  request(app).post(`/bookings/${bookingId}/confirm`).set("Cookie", person.cookie);
const cancel = (person: Person, bookingId: string, app: Express = stack.app) =>
  request(app).delete(`/bookings/${bookingId}`).set("Cookie", person.cookie);
const mine = (person: Person) => request(stack.app).get("/me/bookings").set("Cookie", person.cookie);

const eventRow = async (id: number) => (await stack.db.select().from(events).where(eq(events.id, id)))[0];
const bookingRows = (eventId?: number) =>
  eventId === undefined
    ? stack.db.select().from(bookings)
    : stack.db.select().from(bookings).where(eq(bookings.eventId, eventId));

/** booked_seats must always equal the quantities of held + confirmed bookings, and never exceed capacity. */
async function expectSeatsConsistent(eventId: number): Promise<void> {
  const event = await eventRow(eventId);
  const active = (await bookingRows(eventId))
    .filter((b) => b.status === "held" || b.status === "confirmed")
    .reduce((sum, b) => sum + b.quantity, 0);
  expect(event?.bookedSeats).toBe(active);
  expect(event?.bookedSeats ?? 0).toBeLessThanOrEqual(event?.capacity ?? 0);
}

describe("POST /events/:id/bookings", () => {
  it("needs a logged-in user", async () => {
    const id = await addEvent();
    const res = await request(stack.app).post(`/events/${id}/bookings`).set("Idempotency-Key", newKey()).send({ quantity: 1 });
    expect(res.status).toBe(401);
    expect(await bookingRows()).toHaveLength(0);
  });

  it("needs an Idempotency-Key, and says so in plain words", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent()];
    const missing = await book(alice, id, 1, null);
    expect(missing.status).toBe(400);
    expect(missing.body.details.fields["Idempotency-Key"]).toEqual(["The Idempotency-Key header is required."]);
    for (const bad of ["short", "has spaces in it!", "x".repeat(129), "slash/in/the/key-123"]) {
      const res = await book(alice, id, 1, bad);
      expect(res.status, bad).toBe(400);
    }
    expect(await bookingRows()).toHaveLength(0);
  });

  it.each([[0], [5], [-1], [1.5], ["2"], [null], [undefined], [Number.MAX_SAFE_INTEGER]])("refuses the quantity %j", async (quantity) => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent()];
    const res = await request(stack.app)
      .post(`/events/${id}/bookings`)
      .set("Cookie", alice.cookie)
      .set("Idempotency-Key", newKey())
      .send({ quantity });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(await bookingRows()).toHaveLength(0);
  });

  it("does not let the caller decide anything else about the booking", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent()];
    for (const extra of [{ status: "confirmed" }, { userId: randomUUID() }, { expiresAt: "2099-01-01T00:00:00Z" }, { eventId: 1 }]) {
      const res = await request(stack.app)
        .post(`/events/${id}/bookings`)
        .set("Cookie", alice.cookie)
        .set("Idempotency-Key", newKey())
        .send({ quantity: 1, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await bookingRows()).toHaveLength(0);
  });

  it("holds the seats: 201 with a held booking that lasts 10 minutes", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(20)];
    const before = Date.now();
    const res = await book(alice, id, 3);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ eventId: id, quantity: 3, status: "held", userId: alice.id });
    const lasts = Date.parse(res.body.expiresAt) - before;
    expect(lasts).toBeGreaterThan(599_000 - 2000);
    expect(lasts).toBeLessThan(601_000 + 2000);

    const [row] = await bookingRows(id);
    expect(row?.id).toBe(res.body.id);
    await expectSeatsConsistent(id);
    expect((await eventRow(id))?.bookedSeats).toBe(3);
  });

  it("free seats are updated at once, not after the cache runs out", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    expect((await request(stack.app).get(`/events/${id}/availability`)).body.available).toBe(10);
    await book(alice, id, 4);
    expect((await request(stack.app).get(`/events/${id}/availability`)).body.available).toBe(6);
  });

  it("the hold time is configurable", async () => {
    const short = await stack.makeInstance({ bookingHoldSeconds: 2 });
    const [alice, id] = [await signUp("alice@example.com"), await addEvent()];
    const res = await book(alice, id, 1, newKey(), short.app);
    const lasts = Date.parse(res.body.expiresAt) - Date.now();
    expect(lasts).toBeGreaterThan(500);
    expect(lasts).toBeLessThan(2500);
  });

  it("404 for an event that does not exist or an id that is not an id, and leaves nothing behind", async () => {
    const alice = await signUp("alice@example.com");
    expect((await book(alice, 999999, 1)).status).toBe(404);
    expect((await request(stack.app).post("/events/abc/bookings").set("Cookie", alice.cookie).set("Idempotency-Key", newKey()).send({ quantity: 1 })).status).toBe(404);
    expect(await bookingRows()).toHaveLength(0);
    expect(await stack.db.select().from(idempotencyKeys)).toHaveLength(0);
  });

  it("when only some seats are left, says how many", async () => {
    const [alice, bob, id] = [await signUp("alice@example.com"), await signUp("bob@example.com"), await addEvent(3)];
    expect((await book(alice, id, 2)).status).toBe(201);
    const refused = await book(bob, id, 2);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ code: "SOLD_OUT", message: "Only 1 seat is left.", details: { available: 1 } });
    expect((await book(bob, id, 1)).status).toBe(201);
    await expectSeatsConsistent(id);
  });

  it("when nothing is left, says it is sold out", async () => {
    const [alice, bob, id] = [await signUp("alice@example.com"), await signUp("bob@example.com"), await addEvent(4)];
    expect((await book(alice, id, 4)).status).toBe(201); // fits exactly
    const refused = await book(bob, id, 1);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "SOLD_OUT", message: "Sorry, this event is sold out.", details: { available: 0 } });
    expect(await bookingRows(id)).toHaveLength(1);
  });

  it("works through both api instances", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(2)];
    expect((await book(alice, id, 1, newKey(), apiOne.app)).status).toBe(201);
    expect((await book(alice, id, 1, newKey(), apiTwo.app)).status).toBe(201);
    expect((await book(alice, id, 1, newKey(), apiTwo.app)).status).toBe(409);
  });
});

describe("no overselling under load (assignment check 13)", () => {
  it("300 requests for the last 20 seats, over both instances: exactly 20 get seats, 280 are refused", async () => {
    const id = await addEvent(20);
    const people = await Promise.all(Array.from({ length: 10 }, (_, i) => signUp(`racer${i}@example.com`)));

    const results = await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        book(people[i % people.length] as Person, id, 1, newKey(), i % 2 === 0 ? apiOne.app : apiTwo.app),
      ),
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(20);
    expect(statuses.filter((s) => s === 409)).toHaveLength(280);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true); // no 500 among them
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === "SOLD_OUT")).toBe(true);

    expect((await eventRow(id))?.bookedSeats).toBe(20);
    expect(await bookingRows(id)).toHaveLength(20);
    await expectSeatsConsistent(id);
    expect((await request(stack.app).get(`/events/${id}/availability`)).body.available).toBe(0);
  });

  it("requests for different quantities never push the total over the capacity", async () => {
    const id = await addEvent(25);
    const people = await Promise.all(Array.from({ length: 6 }, (_, i) => signUp(`mixed${i}@example.com`)));
    const results = await Promise.all(
      Array.from({ length: 150 }, (_, i) =>
        book(people[i % people.length] as Person, id, (i % 4) + 1, newKey(), i % 2 === 0 ? apiOne.app : apiTwo.app),
      ),
    );
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    await expectSeatsConsistent(id);
    // Whatever was refused really did not fit at the moment it was refused: the event ends up (nearly) full.
    const event = await eventRow(id);
    expect(event?.bookedSeats).toBeGreaterThanOrEqual(25 - 3);
  });

  it("bookings on one event never block or disturb another event", async () => {
    const [full, other] = [await addEvent(1), await addEvent(50)];
    const people = await Promise.all(Array.from({ length: 5 }, (_, i) => signUp(`iso${i}@example.com`)));
    const results = await Promise.all([
      ...Array.from({ length: 60 }, (_, i) => book(people[i % 5] as Person, full, 1)),
      ...Array.from({ length: 30 }, (_, i) => book(people[i % 5] as Person, other, 1)),
    ]);
    expect(results.slice(60).every((r) => r.status === 201)).toBe(true);
    expect(results.slice(0, 60).filter((r) => r.status === 201)).toHaveLength(1);
    await expectSeatsConsistent(full);
    await expectSeatsConsistent(other);
  });
});

describe("idempotency (assignment check 14)", () => {
  it("repeating a request with the same key gives the same answer and books once", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const key = newKey();
    const first = await book(alice, id, 2, key);
    const again = await book(alice, id, 2, key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(first.headers["idempotent-replay"]).toBeUndefined();
    expect(await bookingRows(id)).toHaveLength(1);
    expect((await eventRow(id))?.bookedSeats).toBe(2);
  });

  it("20 identical requests at once (a double click, a retry storm) make exactly one booking", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const key = newKey();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => book(alice, id, 2, key, i % 2 === 0 ? apiOne.app : apiTwo.app)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.headers["idempotent-replay"] === "true")).toHaveLength(19);
    expect(await bookingRows(id)).toHaveLength(1);
    expect((await eventRow(id))?.bookedSeats).toBe(2);
    expect(await stack.db.select().from(idempotencyKeys)).toHaveLength(1);
  });

  it("the same key with a different quantity or event is refused (422), and books nothing more", async () => {
    const [alice, one, two] = [await signUp("alice@example.com"), await addEvent(10), await addEvent(10)];
    const key = newKey();
    expect((await book(alice, one, 2, key)).status).toBe(201);

    const otherQuantity = await book(alice, one, 3, key);
    expect(otherQuantity.status).toBe(422);
    expect(otherQuantity.body.code).toBe("IDEMPOTENCY_KEY_REUSED");

    expect((await book(alice, two, 2, key)).status).toBe(422);
    expect(await bookingRows()).toHaveLength(1);
    expect((await eventRow(two))?.bookedSeats).toBe(0);
  });

  it("another user may use the same key text: keys belong to a user", async () => {
    const [alice, bob, id] = [await signUp("alice@example.com"), await signUp("bob@example.com"), await addEvent(10)];
    const key = newKey();
    const a = await book(alice, id, 1, key);
    const b = await book(bob, id, 1, key);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it("a 'sold out' answer is repeated too; a new key is needed to try again", async () => {
    const [alice, bob, id] = [await signUp("alice@example.com"), await signUp("bob@example.com"), await addEvent(1)];
    const taken = await book(alice, id, 1);
    const key = newKey();
    const refused = await book(bob, id, 1, key);
    expect(refused.status).toBe(409);

    await cancel(alice, taken.body.id); // a seat is free again
    const retry = await book(bob, id, 1, key);
    expect(retry.status).toBe(409);
    expect(retry.body).toEqual(refused.body);
    expect(retry.headers["idempotent-replay"]).toBe("true");

    expect((await book(bob, id, 1, newKey())).status).toBe(201);
  });

  it("a failed attempt (no such event) does not use up the key", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const key = newKey();
    expect((await book(alice, 999999, 1, key)).status).toBe(404);
    expect((await book(alice, id, 1, key)).status).toBe(201);
  });

  it("repeats the original answer even after the booking has changed", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const key = newKey();
    const first = await book(alice, id, 1, key);
    await confirm(alice, first.body.id);
    const again = await book(alice, id, 1, key);
    expect(again.body).toEqual(first.body); // the saved answer: status "held", as first sent
    expect((await bookingRows(id))[0]?.status).toBe("confirmed");
  });

  it("different keys make different bookings", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const [a, b] = [await book(alice, id, 1), await book(alice, id, 1)];
    expect(a.body.id).not.toBe(b.body.id);
    expect(await bookingRows(id)).toHaveLength(2);
  });
});

describe("POST /bookings/:id/confirm", () => {
  it("confirms your held booking, and the seats stay taken", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const held = (await book(alice, id, 2)).body;
    const res = await confirm(alice, held.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: held.id, status: "confirmed" });
    expect((await eventRow(id))?.bookedSeats).toBe(2);
    await expectSeatsConsistent(id);
  });

  it("confirming twice is harmless", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const held = (await book(alice, id, 2)).body;
    await confirm(alice, held.id);
    const second = await confirm(alice, held.id);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("confirmed");
    await expectSeatsConsistent(id);
  });

  it("someone else's booking looks like it does not exist, and is not touched", async () => {
    const [alice, mallory, id] = [await signUp("alice@example.com"), await signUp("mallory@example.com"), await addEvent(10)];
    const held = (await book(alice, id, 2)).body;
    const res = await confirm(mallory, held.id);
    expect(res.status).toBe(404);
    expect((await bookingRows(id))[0]?.status).toBe("held");
  });

  it("needs a login, and treats a bad or unknown id as 'no such booking'", async () => {
    const alice = await signUp("alice@example.com");
    expect((await request(stack.app).post(`/bookings/${randomUUID()}/confirm`)).status).toBe(401);
    expect((await confirm(alice, randomUUID())).status).toBe(404);
    expect((await confirm(alice, "not-a-uuid")).status).toBe(404);
    expect((await confirm(alice, "1 OR 1=1")).status).toBe(404);
  });

  it("is refused once the time is up, even before the worker has marked it, and the seats are freed at once", async () => {
    const quick = await stack.makeInstance({ bookingHoldSeconds: 1 });
    const [alice, bob, id] = [await signUp("alice@example.com"), await signUp("bob@example.com"), await addEvent(2)];
    const held = (await book(alice, id, 2, newKey(), quick.app)).body;
    expect((await book(bob, id, 1, newKey(), quick.app)).status).toBe(409); // full

    await sleep(1300);
    expect((await bookingRows(id))[0]?.status).toBe("held"); // nobody has expired it yet

    const late = await confirm(alice, held.id, quick.app);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("BOOKING_EXPIRED");

    expect((await bookingRows(id))[0]?.status).toBe("expired");
    expect((await eventRow(id))?.bookedSeats).toBe(0); // free again, right away
    expect((await book(bob, id, 2, newKey(), quick.app)).status).toBe(201);
  });

  it("an expired or cancelled booking cannot be confirmed", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const [a, b] = [(await book(alice, id, 1)).body, (await book(alice, id, 1)).body];
    await stack.db.update(bookings).set({ status: "expired" }).where(eq(bookings.id, a.id));
    await cancel(alice, b.id);
    const expired = await confirm(alice, a.id);
    expect([expired.status, expired.body.code]).toEqual([409, "BOOKING_EXPIRED"]);
    const cancelled = await confirm(alice, b.id);
    expect([cancelled.status, cancelled.body.code]).toEqual([409, "BOOKING_CANCELLED"]);
    await expectSeatsConsistent(id);
  });
});

describe("DELETE /bookings/:id (cancel)", () => {
  it("cancels a held booking and frees its seats at once", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const held = (await book(alice, id, 4)).body;
    expect((await request(stack.app).get(`/events/${id}/availability`)).body.available).toBe(6);
    const res = await cancel(alice, held.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect((await eventRow(id))?.bookedSeats).toBe(0);
    expect((await request(stack.app).get(`/events/${id}/availability`)).body.available).toBe(10);
  });

  it("cancels a confirmed booking too", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const held = (await book(alice, id, 3)).body;
    await confirm(alice, held.id);
    expect((await cancel(alice, held.id)).body.status).toBe("cancelled");
    expect((await eventRow(id))?.bookedSeats).toBe(0);
  });

  it("cancelling twice frees the seats only once (the count never goes below the truth)", async () => {
    const [alice, bob, id] = [await signUp("alice@example.com"), await signUp("bob@example.com"), await addEvent(10)];
    const mine1 = (await book(alice, id, 3)).body;
    await book(bob, id, 2);
    await cancel(alice, mine1.id);
    const again = await cancel(alice, mine1.id);
    expect(again.status).toBe(200);
    expect((await eventRow(id))?.bookedSeats).toBe(2); // bob's seats are still counted
    await expectSeatsConsistent(id);
  });

  it("someone else's booking cannot be cancelled", async () => {
    const [alice, mallory, id] = [await signUp("alice@example.com"), await signUp("mallory@example.com"), await addEvent(10)];
    const held = (await book(alice, id, 2)).body;
    expect((await cancel(mallory, held.id)).status).toBe(404);
    expect((await bookingRows(id))[0]?.status).toBe("held");
    expect((await eventRow(id))?.bookedSeats).toBe(2);
  });

  it("an expired booking cannot be cancelled", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const held = (await book(alice, id, 1)).body;
    await stack.db.update(bookings).set({ status: "expired" }).where(eq(bookings.id, held.id));
    const res = await cancel(alice, held.id);
    expect([res.status, res.body.code]).toEqual([409, "BOOKING_EXPIRED"]);
  });

  it("needs a login and a real booking id", async () => {
    const alice = await signUp("alice@example.com");
    expect((await request(stack.app).delete(`/bookings/${randomUUID()}`)).status).toBe(401);
    expect((await cancel(alice, randomUUID())).status).toBe(404);
    expect((await cancel(alice, "nope")).status).toBe(404);
  });

  it("the freed seats can be booked by someone else", async () => {
    const [alice, bob, id] = [await signUp("alice@example.com"), await signUp("bob@example.com"), await addEvent(2)];
    const held = (await book(alice, id, 2)).body;
    expect((await book(bob, id, 1)).status).toBe(409);
    await cancel(alice, held.id);
    expect((await book(bob, id, 2)).status).toBe(201);
    await expectSeatsConsistent(id);
  });

  it("cancel and confirm racing on one booking leave the seat count correct", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    for (let round = 0; round < 10; round += 1) {
      const held = (await book(alice, id, 1)).body;
      await Promise.all([confirm(alice, held.id), cancel(alice, held.id), cancel(alice, held.id), confirm(alice, held.id)]);
      await expectSeatsConsistent(id);
    }
  });
});

describe("GET /me/bookings", () => {
  it("needs a login and is never cached", async () => {
    expect((await request(stack.app).get("/me/bookings")).status).toBe(401);
    const alice = await signUp("alice@example.com");
    expect((await mine(alice)).headers["cache-control"]).toBe("no-store");
  });

  it("shows only your own bookings, newest first, with the event", async () => {
    const [alice, bob, id] = [await signUp("alice@example.com"), await signUp("bob@example.com"), await addEvent(50, { title: "The Show" })];
    const first = (await book(alice, id, 1)).body;
    await sleep(15);
    const second = (await book(alice, id, 2)).body;
    await book(bob, id, 3);

    const res = await mine(alice);
    expect(res.body.items.map((b: { id: string }) => b.id)).toEqual([second.id, first.id]);
    expect(res.body.items.every((b: { userId: string }) => b.userId === alice.id)).toBe(true);
    expect(res.body.items[0].event).toMatchObject({ title: "The Show", city: "Bookville", venue: "v" });
    expect(JSON.stringify(res.body)).not.toContain(bob.id);
    expect((await mine(bob)).body.items).toHaveLength(1);
  });

  it("counts only active bookings: held in time or confirmed", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(50)];
    const [held, toConfirm, toCancel, toExpire] = [
      (await book(alice, id, 1)).body,
      (await book(alice, id, 1)).body,
      (await book(alice, id, 1)).body,
      (await book(alice, id, 1)).body,
    ];
    await confirm(alice, toConfirm.id);
    await cancel(alice, toCancel.id);
    await stack.db.update(bookings).set({ status: "expired" }).where(eq(bookings.id, toExpire.id));

    const res = await mine(alice);
    expect(res.body.activeCount).toBe(2);
    const byId = Object.fromEntries(res.body.items.map((b: { id: string; status: string }) => [b.id, b.status]));
    expect(byId).toEqual({ [held.id]: "held", [toConfirm.id]: "confirmed", [toCancel.id]: "cancelled", [toExpire.id]: "expired" });
  });

  it("a held booking whose time is up is shown as expired and not counted, even before the worker runs", async () => {
    const quick = await stack.makeInstance({ bookingHoldSeconds: 1 });
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(50)];
    await book(alice, id, 1, newKey(), quick.app);
    expect((await mine(alice)).body.activeCount).toBe(1);
    await sleep(1300);
    const res = await mine(alice);
    expect(res.body.items[0].status).toBe("expired");
    expect(res.body.activeCount).toBe(0);
    expect((await bookingRows(id))[0]?.status).toBe("held");
  });

  it("lists at most 100 but counts all active ones", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(500)];
    await stack.db.insert(bookings).values(
      Array.from({ length: 120 }, () => ({ userId: alice.id, eventId: id, quantity: 1, status: "held" as const, expiresAt: new Date(Date.now() + 600_000) })),
    );
    const res = await mine(alice);
    expect(res.body.items).toHaveLength(100);
    expect(res.body.activeCount).toBe(120);
  });

  it("is empty for a new user", async () => {
    const alice = await signUp("alice@example.com");
    expect((await mine(alice)).body).toEqual({ items: [], activeCount: 0 });
  });
});

describe("GET /bookings/:id", () => {
  const one = (person: Person | undefined, id: string) => {
    const req = request(stack.app).get(`/bookings/${id}`);
    if (person) req.set("Cookie", person.cookie);
    return req;
  };

  it("shows your booking with its event, and is never cached", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10, { title: "Seen" })];
    const held = (await book(alice, id, 2)).body;
    const res = await one(alice, held.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: held.id, status: "held", quantity: 2, event: { title: "Seen" } });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("someone else's booking, an unknown one and a bad id all look the same: 404", async () => {
    const [alice, mallory, id] = [await signUp("alice@example.com"), await signUp("mallory@example.com"), await addEvent(10)];
    const held = (await book(alice, id, 1)).body;
    expect((await one(mallory, held.id)).status).toBe(404);
    expect((await one(alice, randomUUID())).status).toBe(404);
    expect((await one(alice, "nope")).status).toBe(404);
    expect((await one(undefined, held.id)).status).toBe(401);
  });

  it("a held booking whose time is up is shown as expired", async () => {
    const quick = await stack.makeInstance({ bookingHoldSeconds: 1 });
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const held = (await book(alice, id, 1, newKey(), quick.app)).body;
    await sleep(1300);
    expect((await one(alice, held.id)).body.status).toBe("expired");
  });
});

describe("PATCH /events/:id (administrators)", () => {
  const patch = (person: Person | undefined, id: number | string, body: unknown, app: Express = stack.app) => {
    const req = request(app).patch(`/events/${id}`);
    if (person) req.set("Cookie", person.cookie);
    return req.send(body as object);
  };

  it("is for administrators only", async () => {
    const [alice, admin, id] = [await signUp("alice@example.com"), await signUpAdmin(), await addEvent()];
    expect((await patch(undefined, id, { version: 1, title: "Hacked" })).status).toBe(401);
    const forbidden = await patch(alice, id, { version: 1, title: "Hacked" });
    expect([forbidden.status, forbidden.body.code]).toEqual([403, "FORBIDDEN"]);
    expect((await eventRow(id))?.title).toBe("Booking test");
    expect((await patch(admin, id, { version: 1, title: "Official" })).status).toBe(200);
  });

  it("changes the event, raises the version by one, and returns what was saved", async () => {
    const [admin, id] = [await signUpAdmin(), await addEvent(20)];
    const before = await eventRow(id);
    await sleep(10);
    const res = await patch(admin, id, { version: 1, title: "  New title  ", description: "New description", capacity: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, title: "New title", description: "New description", capacity: 30, version: 2, city: "Bookville" });
    expect(Date.parse(res.body.updatedAt)).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);
    expect((await eventRow(id))?.version).toBe(2);
  });

  it("the change is visible at once on both instances: event, list and free seats", async () => {
    const [admin, id] = [await signUpAdmin(), await addEvent(20)];
    await request(apiOne.app).get(`/events/${id}`);
    await request(apiTwo.app).get(`/events/${id}`);
    await request(apiTwo.app).get(`/events?city=Bookville`);
    await request(apiTwo.app).get(`/events/${id}/availability`);

    await patch(admin, id, { version: 1, title: "Renamed", capacity: 35 }, apiOne.app);

    expect((await request(apiTwo.app).get(`/events/${id}`)).body).toMatchObject({ title: "Renamed", capacity: 35, version: 2 });
    expect((await request(apiTwo.app).get(`/events?city=Bookville`)).body.items[0].title).toBe("Renamed");
    expect((await request(apiOne.app).get(`/events/${id}/availability`)).body).toMatchObject({ capacity: 35, available: 35 });
  });

  it("an edit made from an old version is refused and shows what is saved now", async () => {
    const [admin, id] = [await signUpAdmin(), await addEvent(20)];
    expect((await patch(admin, id, { version: 1, title: "First editor" })).status).toBe(200);

    const stale = await patch(admin, id, { version: 1, title: "Second editor", description: "Second description" });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    expect(stale.body.details.current).toMatchObject({ id, title: "First editor", version: 2 });
    expect((await eventRow(id))?.title).toBe("First editor");
    expect((await eventRow(id))?.description).toBe("d");
  });

  it("20 editors saving the same version at once: exactly one wins", async () => {
    const [admin, id] = [await signUpAdmin(), await addEvent(20)];
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => patch(admin, id, { version: 1, title: `Editor ${i}` }, i % 2 === 0 ? apiOne.app : apiTwo.app)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.code === "VERSION_CONFLICT")).toHaveLength(19);
    expect((await eventRow(id))?.version).toBe(2);
    const winner = results.find((r) => r.status === 200);
    expect((await eventRow(id))?.title).toBe(winner?.body.title);
  });

  it("will not lower the capacity below the seats already taken", async () => {
    const [admin, alice, id] = [await signUpAdmin(), await signUp("alice@example.com"), await addEvent(10)];
    await book(alice, id, 4);
    const refused = await patch(admin, id, { version: 1, capacity: 3 });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "CAPACITY_TOO_LOW", details: { bookedSeats: 4 } });
    expect(refused.body.message).toContain("4 seats");
    expect((await eventRow(id))?.capacity).toBe(10);
    expect((await eventRow(id))?.version).toBe(1);

    expect((await patch(admin, id, { version: 1, capacity: 4 })).status).toBe(200); // exactly the seats taken is fine
    expect((await request(stack.app).get(`/events/${id}/availability`)).body.available).toBe(0);
  });

  it("raising the capacity makes seats available for booking", async () => {
    const [admin, alice, id] = [await signUpAdmin(), await signUp("alice@example.com"), await addEvent(2)];
    await book(alice, id, 2);
    expect((await book(alice, id, 1)).status).toBe(409);
    await patch(admin, id, { version: 1, capacity: 5 });
    expect((await book(alice, id, 3)).status).toBe(201);
    await expectSeatsConsistent(id);
  });

  it.each([
    ["an empty title", { version: 1, title: "   " }],
    ["a title over 200 characters", { version: 1, title: "x".repeat(201) }],
    ["a description over 5000 characters", { version: 1, description: "x".repeat(5001) }],
    ["capacity 0", { version: 1, capacity: 0 }],
    ["a negative capacity", { version: 1, capacity: -5 }],
    ["a fractional capacity", { version: 1, capacity: 1.5 }],
    ["a huge capacity", { version: 1, capacity: 10_000_000 }],
    ["no version", { title: "No version" }],
    ["version 0", { version: 0, title: "Zero" }],
    ["a version given as text", { version: "1", title: "Text" }],
    ["no change at all", { version: 1 }],
    ["a field that is not editable (city)", { version: 1, city: "Elsewhere" }],
    ["the seats taken", { version: 1, bookedSeats: 0 }],
    ["an id", { version: 1, id: 5 }],
  ])("refuses %s, and changes nothing", async (_name, body) => {
    const [admin, id] = [await signUpAdmin(), await addEvent(10)];
    const res = await patch(admin, id, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    const after = await eventRow(id);
    expect([after?.title, after?.city, after?.capacity, after?.version]).toEqual(["Booking test", "Bookville", 10, 1]);
  });

  it("says what is wrong with each field in plain words", async () => {
    const [admin, id] = [await signUpAdmin(), await addEvent(10)];
    const res = await patch(admin, id, { version: 1, title: "", capacity: 0 });
    expect(res.body.details.fields).toEqual({ title: ["Title is required"], capacity: ["Capacity must be at least 1"] });
  });

  it("404 for an event that does not exist, and for an id that is not an id", async () => {
    const admin = await signUpAdmin();
    expect((await patch(admin, 999999, { version: 1, title: "x" })).status).toBe(404);
    expect((await patch(admin, "abc", { version: 1, title: "x" })).status).toBe(404);
  });

  it("saving the same values changes nothing, not even the version", async () => {
    const [admin, id] = [await signUpAdmin(), await addEvent(10)];
    const res = await patch(admin, id, { version: 1, title: "Booking test" });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(await stack.db.select().from(outbox)).toHaveLength(0);
  });

  it("every real change leaves a note for the web app to refresh (outbox)", async () => {
    const [admin, id] = [await signUpAdmin(), await addEvent(10)];
    await patch(admin, id, { version: 1, title: "One" });
    await patch(admin, id, { version: 2, capacity: 12 });
    const notes = await stack.db.select().from(outbox).where(eq(outbox.eventId, id));
    expect(notes.map((n) => n.eventVersion).sort()).toEqual([2, 3]);
  });

  it("the edit tells the rest of the system, once, with the saved event", async () => {
    const seen: unknown[] = [];
    const watched = await stack.makeInstance({}, { onEventUpdated: (event) => void seen.push(event) });
    const [admin, id] = [await signUpAdmin(), await addEvent(10)];
    await patch(admin, id, { version: 1, title: "Heard about" }, watched.app);
    await patch(admin, id, { version: 1, title: "Refused: old version" }, watched.app);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id, title: "Heard about", version: 2 });
  });

  it("the outbox note carries the id of the request that made the change", async () => {
    const [admin, id] = [await signUpAdmin(), await addEvent(10)];
    await request(stack.app).patch(`/events/${id}`).set("Cookie", admin.cookie).set("X-Request-Id", "trace-this-request-123").send({ version: 1, title: "Traced" });
    const [note] = await stack.db.select().from(outbox).where(eq(outbox.eventId, id));
    expect(note?.requestId).toBe("trace-this-request-123");
    // An edit made by hand has no request id.
    await stack.pool.query("UPDATE events SET description = 'by hand' WHERE id = $1", [id]);
    const notes = await stack.db.select().from(outbox).where(eq(outbox.eventId, id));
    expect(notes.map((n) => n.requestId).sort()).toEqual([null, "trace-this-request-123"].sort());
  });

  it("a request from another website is blocked", async () => {
    const [admin, id] = [await signUpAdmin(), await addEvent(10)];
    const res = await request(stack.app).patch(`/events/${id}`).set("Cookie", admin.cookie).set("Origin", "http://evil.example").send({ version: 1, title: "Hacked" });
    expect(res.status).toBe(403);
    expect((await eventRow(id))?.title).toBe("Booking test");
  });
});

describe("a full day in the life", () => {
  it("book, confirm, cancel, rebook: the numbers always add up", async () => {
    const [alice, bob, id] = [await signUp("alice@example.com"), await signUp("bob@example.com"), await addEvent(6)];
    const a = (await book(alice, id, 4)).body;
    const b = (await book(bob, id, 2)).body;
    expect((await book(alice, id, 1)).status).toBe(409);
    await confirm(alice, a.id);
    await cancel(bob, b.id);
    expect((await book(alice, id, 2)).status).toBe(201);
    expect((await request(stack.app).get(`/events/${id}/availability`)).body.available).toBe(0);
    expect((await mine(alice)).body.activeCount).toBe(2);
    expect((await mine(bob)).body.activeCount).toBe(0);
    await expectSeatsConsistent(id);
  });

  it("the documentation lists the booking endpoints", async () => {
    const res = await request(stack.app).get("/openapi.json");
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(["/events/{id}/bookings", "/bookings/{id}/confirm", "/bookings/{id}", "/me/bookings"]),
    );
    const params = res.body.paths["/events/{id}/bookings"].post.parameters.map((p: { name: string }) => p.name);
    expect(params).toContain("Idempotency-Key");
  });
});

