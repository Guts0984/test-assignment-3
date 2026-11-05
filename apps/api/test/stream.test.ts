import { randomUUID } from "node:crypto";
import { bookings, events, idempotencyKeys, outbox, users } from "@app/db";
import { availabilityChannel } from "@app/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLifecycle } from "../src/infra/lifecycle";
import { createLogger } from "../src/infra/logger";
import { listen, openStream, type ListeningApp, type OpenStream } from "./helpers/sse";
import { startStack, type Instance, type Stack } from "./helpers/stack";

let stack: Stack;
let one: Instance;
let two: Instance;
let serverOne: ListeningApp;
let serverTwo: ListeningApp;

beforeAll(async () => {
  stack = await startStack();
  one = await stack.makeInstance({ sseHeartbeatMs: 150 });
  two = await stack.makeInstance({ sseHeartbeatMs: 150 });
  serverOne = await listen(one.app);
  serverTwo = await listen(two.app);
});
afterAll(async () => {
  await serverOne.stop();
  await serverTwo.stop();
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
interface Person {
  id: string;
  cookie: string;
}
async function signUp(email: string): Promise<Person> {
  const res = await request(one.app).post("/auth/register").send({ email, password });
  const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("sid="))?.split(";")[0] ?? "";
  return { id: res.body.id, cookie };
}
async function addEvent(capacity = 10): Promise<number> {
  const [row] = await stack.db
    .insert(events)
    .values({ title: "Stream test", description: "d", city: "Streamville", venue: "v", startsAt: new Date("2031-06-01T10:00:00Z"), capacity })
    .returning();
  if (!row) throw new Error("no event");
  return row.id;
}
const book = (person: Person, eventId: number, quantity: number, app = two.app) =>
  request(app).post(`/events/${eventId}/bookings`).set("Cookie", person.cookie).set("Idempotency-Key", `key-${randomUUID()}`).send({ quantity });
const availabilities = (stream: OpenStream) => stream.messages.filter((m) => m.event === "availability").map((m) => m.data as { available: number; capacity: number; eventId: number });
const lastAvailable = (stream: OpenStream) => availabilities(stream).at(-1)?.available;

describe("opening the stream", () => {
  it("is a text/event-stream that nothing may hold back, and it starts with the current number", async () => {
    const id = await addEvent(10);
    const stream = await serverOne.open(`/events/${id}/stream`);
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(stream.headers["cache-control"]).toMatch(/no-cache/);
    expect(stream.headers["x-accel-buffering"]).toBe("no");

    await stream.waitFor(() => availabilities(stream).length >= 1);
    expect(availabilities(stream)[0]).toEqual({ eventId: id, capacity: 10, available: 10 });
    expect(stream.raw()).toMatch(/^retry: 3000\n\n/);
  });

  it("the first number is the true one, not an old cached one", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    await request(serverOne.port ? one.app : one.app).get(`/events/${id}/availability`); // fills the 1-second cache with 10
    await stack.db.insert(bookings).values({ userId: alice.id, eventId: id, quantity: 4, expiresAt: new Date(Date.now() + 600_000) });
    const stream = await serverOne.open(`/events/${id}/stream`);
    await stream.waitFor(() => availabilities(stream).length >= 1);
    expect(availabilities(stream)[0]?.available).toBe(6);
  });

  it("404 as a normal JSON error, not a stream, for an event that does not exist or an id that is not an id", async () => {
    for (const path of ["/events/999999/stream", "/events/abc/stream", "/events/0/stream"]) {
      const stream = await serverOne.open(path);
      expect(stream.status, path).toBe(404);
      expect(stream.headers["content-type"], path).toMatch(/application\/json/);
    }
  });
});

describe("live updates (assignment checks 16 and 17)", () => {
  it("a booking made on the OTHER instance reaches viewers on both instances", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const [watchOne, watchTwo] = [await serverOne.open(`/events/${id}/stream`), await serverTwo.open(`/events/${id}/stream`)];
    await watchOne.waitFor(() => availabilities(watchOne).length >= 1);
    await watchTwo.waitFor(() => availabilities(watchTwo).length >= 1);

    expect((await book(alice, id, 3, two.app)).status).toBe(201);

    await watchOne.waitFor(() => lastAvailable(watchOne) === 7, 2000, "7 free seats on instance one");
    await watchTwo.waitFor(() => lastAvailable(watchTwo) === 7, 2000, "7 free seats on instance two");
  });

  it("a cancellation is announced too", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const held = (await book(alice, id, 4)).body;
    const watch = await serverOne.open(`/events/${id}/stream`);
    await watch.waitFor(() => lastAvailable(watch) === 6);
    await request(one.app).delete(`/bookings/${held.id}`).set("Cookie", alice.cookie);
    await watch.waitFor(() => lastAvailable(watch) === 10, 2000, "10 free seats after the cancellation");
  });

  it("a booking that expires in time is announced when someone tries to confirm it late", async () => {
    const quick = await stack.makeInstance({ bookingHoldSeconds: 1 });
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(5)];
    const held = (await book(alice, id, 2, quick.app)).body;
    const watch = await serverOne.open(`/events/${id}/stream`);
    await watch.waitFor(() => lastAvailable(watch) === 3);
    await new Promise((r) => setTimeout(r, 1300));
    await request(quick.app).post(`/bookings/${held.id}/confirm`).set("Cookie", alice.cookie);
    await watch.waitFor(() => lastAvailable(watch) === 5, 2000, "5 free seats after the expiry");
  });

  it("an admin changing the capacity is announced with the new capacity", async () => {
    const [admin, id] = [await signUp("admin@example.com"), await addEvent(10)];
    await stack.db.update(users).set({ role: "admin" }).where(eq(users.id, admin.id));
    const watch = await serverTwo.open(`/events/${id}/stream`);
    await watch.waitFor(() => availabilities(watch).length >= 1);
    await request(one.app).patch(`/events/${id}`).set("Cookie", admin.cookie).send({ version: 1, capacity: 25 });
    await watch.waitFor(() => availabilities(watch).at(-1)?.capacity === 25, 2000, "capacity 25");
    expect(lastAvailable(watch)).toBe(25);
  });

  it("a burst of 40 bookings ends with the true number, and is not sent as 40 separate messages", async () => {
    const id = await addEvent(100);
    const people = await Promise.all(Array.from({ length: 8 }, (_, i) => signUp(`burst${i}@example.com`)));
    const watch = await serverOne.open(`/events/${id}/stream`);
    await watch.waitFor(() => availabilities(watch).length >= 1);

    await Promise.all(Array.from({ length: 40 }, (_, i) => book(people[i % 8] as Person, id, 1, i % 2 === 0 ? one.app : two.app)));

    await watch.waitFor(() => lastAvailable(watch) === 60, 3000, "60 free seats");
    expect(availabilities(watch).length).toBeLessThan(25);
    expect(availabilities(watch).every((m, i, all) => i === 0 || m.available <= (all[i - 1]?.available ?? 100))).toBe(true); // only goes down
  });

  it("confirming a booking changes no seats, so nothing is sent", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const held = (await book(alice, id, 2)).body;
    const watch = await serverOne.open(`/events/${id}/stream`);
    await watch.waitFor(() => lastAvailable(watch) === 8);
    const before = availabilities(watch).length;
    await request(one.app).post(`/bookings/${held.id}/confirm`).set("Cookie", alice.cookie);
    await new Promise((r) => setTimeout(r, 200));
    expect(availabilities(watch).length).toBe(before);
  });

  it("viewers of one event never get another event's numbers", async () => {
    const [alice, a, b] = [await signUp("alice@example.com"), await addEvent(10), await addEvent(10)];
    const watchA = await serverOne.open(`/events/${a}/stream`);
    await watchA.waitFor(() => availabilities(watchA).length >= 1);
    await book(alice, b, 5);
    await new Promise((r) => setTimeout(r, 200));
    expect(availabilities(watchA).every((m) => m.eventId === a && m.available === 10)).toBe(true);
  });

  it("200 viewers of the same event all get the update", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const viewers = await Promise.all(Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? serverOne : serverTwo).open(`/events/${id}/stream`)));
    await Promise.all(viewers.map((v) => v.waitFor(() => availabilities(v).length >= 1)));
    await book(alice, id, 1);
    await Promise.all(viewers.map((v) => v.waitFor(() => lastAvailable(v) === 9, 3000, "9 free seats")));
  });
});

describe("keeping the stream alive and tidy", () => {
  it("sends a keep-alive line now and then, so proxies do not close an idle stream", async () => {
    const id = await addEvent(10);
    const watch = await serverOne.open(`/events/${id}/stream`);
    await watch.waitFor(() => watch.comments.length >= 2, 2000, "two keep-alive lines");
    expect(watch.comments.every((c) => c.startsWith(": ping"))).toBe(true);
  });

  it("forgets a viewer who leaves, so nothing is kept for nobody", async () => {
    const id = await addEvent(10);
    const base = one.hub.size();
    const watch = await serverOne.open(`/events/${id}/stream`);
    await watch.waitFor(() => one.hub.size() === base + 1, 2000, "the viewer to be registered");
    watch.close();
    await new Promise<void>((resolve, reject) => {
      const until = Date.now() + 2000;
      const timer = setInterval(() => {
        if (one.hub.size() === base) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() > until) {
          clearInterval(timer);
          reject(new Error("the viewer was never forgotten"));
        }
      }, 10);
    });
  });

  it("ignores announcements it cannot understand, and keeps working", async () => {
    const [alice, id] = [await signUp("alice@example.com"), await addEvent(10)];
    const watch = await serverOne.open(`/events/${id}/stream`);
    await watch.waitFor(() => availabilities(watch).length >= 1);

    await stack.redis.publish(availabilityChannel(id), "this is not json");
    await stack.redis.publish(availabilityChannel(id), JSON.stringify({ eventId: id, capacity: "lots", available: -3 }));
    await stack.redis.publish(availabilityChannel(id), JSON.stringify({ eventId: id + 1, capacity: 10, available: 1 })); // names another event
    await stack.redis.publish("availability:abc", JSON.stringify({ eventId: 1, capacity: 1, available: 1 }));
    await new Promise((r) => setTimeout(r, 150));
    expect(availabilities(watch)).toHaveLength(1);

    await book(alice, id, 1);
    await watch.waitFor(() => lastAvailable(watch) === 9);
  });

  it("opening a stream counts as a request against the visitor's limit", async () => {
    const limited = await stack.makeInstance({
      rateLimit: { general: { max: 2, windowSeconds: 60 }, loginPerIp: { max: 100, windowSeconds: 60 }, loginPerEmail: { max: 100, windowSeconds: 60 } },
    });
    const id = await addEvent(10);
    const server = await listen(limited.app);
    try {
      const headers = { "X-Forwarded-For": "198.51.100.200" };
      expect((await server.open(`/events/${id}/stream`, headers)).status).toBe(200);
      expect((await server.open(`/events/${id}/stream`, headers)).status).toBe(200);
      expect((await server.open(`/events/${id}/stream`, headers)).status).toBe(429);
    } finally {
      await server.stop();
    }
  });
});

describe("shutting down with streams open (assignment check 25)", () => {
  it("ends every stream politely and finishes quickly, without cutting anyone off", async () => {
    const id = await addEvent(10);
    const instance = await stack.makeInstance();
    const lifecycle = createLifecycle({ logger: createLogger("silent"), timeoutMs: 8000 });
    lifecycle.onShutdown(() => instance.hub.closeAll());
    const server = instance.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;

    const viewers = await Promise.all(Array.from({ length: 20 }, () => openStream(port, `/events/${id}/stream`)));
    await Promise.all(viewers.map((v) => v.waitFor(() => availabilities(v).length >= 1)));

    const started = Date.now();
    await lifecycle.shutdown(server, async () => undefined);
    const took = Date.now() - started;

    expect(took).toBeLessThan(2000); // not the 8-second wait for connections that never end
    await Promise.all(viewers.map((v) => v.waitFor(() => v.ended(), 1000, "the stream to end")));
    expect(server.listening).toBe(false);
  });

  it("without the shutdown hook the same server would wait for the timeout: the hook is what makes it quick", async () => {
    const id = await addEvent(10);
    const instance = await stack.makeInstance();
    const lifecycle = createLifecycle({ logger: createLogger("silent"), timeoutMs: 1500 });
    const server = instance.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const viewer = await openStream(port, `/events/${id}/stream`);
    await viewer.waitFor(() => availabilities(viewer).length >= 1);

    const started = Date.now();
    await lifecycle.shutdown(server, async () => undefined);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
  });
});

describe("documentation", () => {
  it("lists the stream endpoint", async () => {
    const res = await request(one.app).get("/openapi.json");
    expect(Object.keys(res.body.paths)).toContain("/events/{id}/stream");
  });
});
