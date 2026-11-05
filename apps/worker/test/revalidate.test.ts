import { events, idempotencyKeys, outbox, users } from "@app/db";
import { CACHE_GENERATION_CHANNEL, CATALOG_GENERATION, generationKey, OUTBOX_WAKE_CHANNEL } from "@app/shared";
import { verifyInternalRequest } from "@app/shared/internal";
import { eq } from "drizzle-orm";
import { Queue } from "bullmq";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { cleanOldRecords } from "../src/jobs/cleanup";
import { connectionFromUrl } from "../src/worker";
import { createWorld, SECRET, sleep, startFakeWeb, until, type FakeWeb, type TestWorld } from "./helpers/env";

let world: TestWorld;
const toStop: FakeWeb[] = [];

// Every test gets its own database and its own workers, so no test can see another's leftovers.
beforeEach(async () => {
  world = await createWorld();
});
afterEach(async () => {
  await world.close(); // stops the workers first
  await Promise.all(toStop.splice(0).map((web) => web.stop().catch(() => undefined)));
});

async function fakeWeb(...args: Parameters<typeof startFakeWeb>): Promise<FakeWeb> {
  const web = await startFakeWeb(...args);
  toStop.push(web);
  return web;
}

async function makeEvent(title = "Delivery"): Promise<number> {
  const [row] = await world.db
    .insert(events)
    .values({ title, description: "d", city: "Deliveryville", venue: "v", startsAt: new Date("2031-01-01T10:00:00Z"), capacity: 10 })
    .returning();
  if (!row) throw new Error("no event");
  return row.id;
}
/** Changes the event (the database adds a note to the outbox). Returns the new version. */
async function edit(eventId: number, title: string): Promise<number> {
  const [row] = await world.db.update(events).set({ title }).where(eq(events.id, eventId)).returning();
  return row?.version ?? 0;
}
const note = async (eventId: number, version: number) =>
  (await world.db.select().from(outbox).where(eq(outbox.eventId, eventId))).find((n) => n.eventVersion === version);
const isDispatched = async (eventId: number, version: number) => Boolean((await note(eventId, version))?.dispatchedAt);

describe("telling the web app that an event changed (assignment check 9)", () => {
  it("sends one signed request that only our own programs could have made", async () => {
    const web = await fakeWeb("ok");
    const id = await makeEvent();
    const version = await edit(id, "Changed");
    await world.startWorker({ webUrl: web.url, outboxPollMs: 50 });

    await until(() => web.succeeded().length === 1, 5000, "the web app to be told");
    const [seen] = web.succeeded();
    expect(seen?.method).toBe("POST");
    expect(JSON.parse(seen?.body ?? "{}")).toEqual({ eventId: id, version });
    expect(seen?.headers["content-type"]).toBe("application/json");
    expect(verifyInternalRequest(SECRET, seen?.headers ?? {})).toEqual({ trusted: true, ip: undefined });
    expect(verifyInternalRequest("a-different-secret-a-different-secret", seen?.headers ?? {}).trusted).toBe(false);
  });

  it("checks the note off only after the web app has answered", async () => {
    const web = await fakeWeb("ok");
    const id = await makeEvent();
    const version = await edit(id, "Changed");
    expect(await isDispatched(id, version)).toBe(false);
    await world.startWorker({ webUrl: web.url, outboxPollMs: 50 });
    await until(() => isDispatched(id, version), 5000, "the note to be checked off");
    expect(web.succeeded()).toHaveLength(1);
  });

  it("a change made by hand in the database is noticed too", async () => {
    const web = await fakeWeb("ok");
    const id = await makeEvent();
    await world.pool.query("UPDATE events SET description = 'edited with SQL' WHERE id = $1", [id]);
    await world.startWorker({ webUrl: web.url, outboxPollMs: 50 });
    await until(() => web.succeeded().length === 1, 5000, "the web app to be told");
  });

  it("passes the id of the request that caused the change, so the logs can be followed", async () => {
    const web = await fakeWeb("ok");
    const id = await makeEvent();
    // Like the api does: note the request id for this transaction, then edit.
    const client = await world.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.request_id', 'trace-abc-123456', true)");
      await client.query("UPDATE events SET title = 'Traced' WHERE id = $1", [id]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const other = await makeEvent("Other");
    await edit(other, "No request id");
    await world.startWorker({ webUrl: web.url, outboxPollMs: 50 });
    await until(() => web.succeeded().length === 2, 5000, "two deliveries");
    const traced = web.succeeded().find((r) => JSON.parse(r.body).eventId === id);
    const plain = web.succeeded().find((r) => JSON.parse(r.body).eventId === other);
    expect(traced?.headers["x-request-id"]).toBe("trace-abc-123456");
    expect(plain?.headers["x-request-id"]).toBeUndefined();
  });

  it("clears the api caches BEFORE it tells the web app, also for an edit that never went through the api", async () => {
    const heard: { at: number; gen: number }[] = [];
    const listener = world.redis.duplicate();
    await listener.subscribe(CACHE_GENERATION_CHANNEL);
    listener.on("message", (_channel, message) => {
      const parsed = JSON.parse(message) as { name: string; gen: number };
      if (parsed.name === CATALOG_GENERATION) heard.push({ at: Date.now(), gen: parsed.gen });
    });
    try {
      const web = await fakeWeb("ok");
      const id = await makeEvent();
      const before = Number((await world.redis.get(generationKey(CATALOG_GENERATION))) ?? 0);
      await edit(id, "Changed by hand in SQL"); // not through the api: nobody cleared any cache
      await world.startWorker({ webUrl: web.url, outboxPollMs: 50 });

      await until(() => web.succeeded().length === 1, 5000, "the web app to be told");
      const after = Number(await world.redis.get(generationKey(CATALOG_GENERATION)));
      expect(after).toBeGreaterThan(before);
      expect(heard.length).toBeGreaterThanOrEqual(1);
      // The api instances heard about it before the web app was asked to read the event again.
      expect(heard[0]?.at ?? Infinity).toBeLessThanOrEqual(web.requests[0]?.at ?? 0);
      expect(heard[0]?.gen).toBe(after);
    } finally {
      listener.disconnect();
    }
  });

  it("each version of an event is announced, in the order they happened", async () => {
    const web = await fakeWeb("ok");
    const id = await makeEvent();
    const [v2, v3, v4] = [await edit(id, "Two"), await edit(id, "Three"), await edit(id, "Four")];
    await world.startWorker({ webUrl: web.url, outboxPollMs: 50 });
    await until(() => web.succeeded().length === 3, 5000, "three deliveries");
    expect(web.succeeded().map((r) => JSON.parse(r.body).version).sort()).toEqual([v2, v3, v4]);
  });

  it("looks at the outbox at once when told to, not only at the next poll", async () => {
    const web = await fakeWeb("ok");
    const worker = await world.startWorker({ webUrl: web.url, outboxPollMs: 60_000 });
    await worker.pollOutbox();
    const id = await makeEvent();
    await edit(id, "Wake up");
    expect(web.succeeded()).toHaveLength(0);
    await world.redis.publish(OUTBOX_WAKE_CHANNEL, "1");
    await until(() => web.succeeded().length === 1, 2000, "the web app to be told right away");
  });
});

describe("when the web app is not answering (assignment: retries with growing pauses)", () => {
  it("tries again after errors, a dropped connection and a slow answer, and finally gets through", async () => {
    const web = await fakeWeb((attempt) => (attempt === 1 ? "error" : attempt === 2 ? "drop" : attempt === 3 ? "slow" : "ok"));
    const id = await makeEvent();
    const version = await edit(id, "Hard to deliver");
    await world.startWorker({ webUrl: web.url, outboxPollMs: 50, backoffMs: 100, timeoutMs: 300, attempts: 6 });

    await until(() => web.succeeded().length === 1, 8000, "the fourth attempt to succeed");
    expect(web.requests.map((r) => r.answered)).toEqual(["error", "dropped", "slow", "ok"]);
    await until(() => isDispatched(id, version), 3000, "the note to be checked off");
  });

  it("waits longer each time", async () => {
    const web = await fakeWeb("error");
    const id = await makeEvent();
    await edit(id, "Waiting game");
    await world.startWorker({ webUrl: web.url, outboxPollMs: 50, backoffMs: 150, attempts: 5 });

    await until(() => web.requests.length >= 5, 10_000, "five attempts");
    const gaps = web.requests.slice(1).map((r, i) => r.at - (web.requests[i]?.at ?? 0));
    // 150, 300, 600, 1200 ms: each pause about twice the one before (allowing some slack for timing).
    expect(gaps[1] ?? 0).toBeGreaterThan((gaps[0] ?? 0) * 1.4);
    expect(gaps[2] ?? 0).toBeGreaterThan((gaps[1] ?? 0) * 1.4);
    expect(gaps[3] ?? 0).toBeGreaterThan((gaps[2] ?? 0) * 1.4);
    expect(gaps[0] ?? 0).toBeGreaterThanOrEqual(120);
  });

  it("does not check the note off while the web app keeps failing", async () => {
    const web = await fakeWeb("error");
    const id = await makeEvent();
    const version = await edit(id, "Never arrives");
    await world.startWorker({ webUrl: web.url, outboxPollMs: 50, backoffMs: 50, attempts: 3 });
    await until(() => web.requests.length >= 3, 5000, "all attempts");
    await sleep(300);
    expect(await isDispatched(id, version)).toBe(false);
    expect(web.requests).toHaveLength(3); // no more than the attempts it was given
  });

  it("an answer that is not a success is a failure, whatever the status", async () => {
    let status = 404;
    const web = await fakeWeb();
    web.behave(() => (status === 200 ? "ok" : "error"));
    const id = await makeEvent();
    await edit(id, "Status check");
    await world.startWorker({ webUrl: web.url, outboxPollMs: 50, backoffMs: 50, attempts: 8 });
    await until(() => web.requests.length >= 2, 4000, "a retry");
    status = 200;
    await until(() => web.succeeded().length === 1, 4000, "success");
  });

  it("keeps trying while the web app is completely down, and delivers once it is back", async () => {
    const first = await startFakeWeb("ok");
    const { port } = first;
    await first.stop(); // nothing listens on this port now
    const id = await makeEvent();
    const version = await edit(id, "While you were out");
    await world.startWorker({ webUrl: first.url, outboxPollMs: 50, backoffMs: 100, attempts: 10, timeoutMs: 300 });

    await sleep(700); // several refused connections
    expect(await isDispatched(id, version)).toBe(false);

    const back = await fakeWeb("ok", port);
    await until(() => back.succeeded().length === 1, 10_000, "delivery after the web app came back");
    await until(() => isDispatched(id, version), 3000, "the note to be checked off");
  });

  it("loses nothing when the worker is restarted in the middle of it", async () => {
    const down = await startFakeWeb("ok");
    const { port, url } = down;
    await down.stop();
    const id = await makeEvent();
    const version = await edit(id, "Restart me");
    const prefix = "restart-test";
    const before = await world.startWorker({ prefix, webUrl: url, outboxPollMs: 50, backoffMs: 100, attempts: 20, timeoutMs: 300 });
    await sleep(400);
    await before.stop(); // a clean stop while the job is waiting for its next try
    expect(await isDispatched(id, version)).toBe(false);

    const web = await fakeWeb("ok", port);
    await world.startWorker({ prefix, webUrl: url, outboxPollMs: 50, backoffMs: 100, attempts: 20, timeoutMs: 300 });
    await until(() => web.succeeded().length >= 1, 10_000, "delivery by the new worker");
    await until(() => isDispatched(id, version), 3000, "the note to be checked off");
  });

  it("a job that used up all its attempts leaves the note unchecked, so the change is not forgotten", async () => {
    const web = await fakeWeb("error");
    const id = await makeEvent();
    const version = await edit(id, "Gave up on me");
    await world.startWorker({ webUrl: web.url, outboxPollMs: 50, backoffMs: 20, attempts: 2 });
    await until(() => web.requests.length >= 2, 4000, "both attempts");
    await sleep(300);
    const row = await note(id, version);
    expect(row).toBeDefined();
    expect(row?.dispatchedAt).toBeNull();
  });
});

describe("several workers (assignment: two workers never do one task twice)", () => {
  it("20 changes with two workers on the same queue: each is delivered exactly once", async () => {
    const web = await fakeWeb("ok");
    const ids = await Promise.all(Array.from({ length: 20 }, (_, i) => makeEvent(`Many ${i}`)));
    for (const id of ids) await edit(id, "Changed");
    const prefix = "two-workers";
    await world.startWorker({ prefix, webUrl: web.url, outboxPollMs: 30 });
    await world.startWorker({ prefix, webUrl: web.url, outboxPollMs: 30 });

    await until(() => web.succeeded().length >= 20, 8000, "20 deliveries");
    await sleep(500); // time for any duplicate to show up
    const delivered = web.succeeded().map((r) => JSON.parse(r.body).eventId as number);
    expect(delivered).toHaveLength(20);
    expect(new Set(delivered)).toEqual(new Set(ids));
  });

  it("a job for a note that was already delivered does nothing (the web app is not called again)", async () => {
    const web = await fakeWeb("ok");
    const id = await makeEvent();
    const version = await edit(id, "Once only");
    const prefix = "already-done";
    await world.pool.query("UPDATE outbox SET dispatched_at = now() WHERE event_id = $1", [id]);

    // A second worker read the note a moment too early and queued it, as it could in a race.
    const queue = new Queue("revalidate", { connection: connectionFromUrl(inject("redisUrl")), prefix });
    await queue.add("revalidate", { eventId: id, version }, { jobId: "stale-copy" });
    await world.startWorker({ prefix, webUrl: web.url, outboxPollMs: 60_000 });
    await until(async () => (await queue.getJobCounts("waiting", "active", "delayed")).waiting === 0, 4000, "the job to be taken");
    await sleep(300);
    await queue.close();
    expect(web.requests).toHaveLength(0);
  });

  it("a job for a note that is still unchecked does call the web app", async () => {
    const web = await fakeWeb("ok");
    const id = await makeEvent();
    const version = await edit(id, "Not done yet");
    const prefix = "not-done";
    const queue = new Queue("revalidate", { connection: connectionFromUrl(inject("redisUrl")), prefix });
    await queue.add("revalidate", { eventId: id, version }, { jobId: "fresh-copy" });
    await world.startWorker({ prefix, webUrl: web.url, outboxPollMs: 60_000 });
    // (The worker also finds the note itself, so the web app may be called by both jobs.)
    await until(() => web.succeeded().length >= 1, 4000, "the web app to be called");
    await queue.close();
  });

  it("looking at the outbox from both workers at once creates no duplicate jobs", async () => {
    const web = await fakeWeb("slow"); // answers slowly, so jobs stay in progress while both workers look again and again
    const id = await makeEvent();
    await edit(id, "One job please");
    const prefix = "no-duplicates";
    const [a, b] = [
      await world.startWorker({ prefix, webUrl: web.url, outboxPollMs: 20, timeoutMs: 400, attempts: 1 }),
      await world.startWorker({ prefix, webUrl: web.url, outboxPollMs: 20, timeoutMs: 400, attempts: 1 }),
    ];
    for (let i = 0; i < 20; i += 1) await Promise.all([a.pollOutbox(), b.pollOutbox()]);
    await sleep(600);
    expect(web.requests.length).toBe(1);
  });
});

describe("stopping", () => {
  it("lets the delivery in progress finish before it stops", async () => {
    let answerAfterMs = 600;
    const slowWeb = await startFakeWeb("ok");
    toStop.push(slowWeb);
    slowWeb.behave(() => "ok");
    // A web app that takes a while to answer, but does answer.
    const http = await import("node:http");
    const delayed = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => setTimeout(() => res.writeHead(200).end("{}"), answerAfterMs));
    });
    await new Promise<void>((resolve) => delayed.listen(0, "127.0.0.1", resolve));
    const port = (delayed.address() as { port: number }).port;

    const id = await makeEvent();
    const version = await edit(id, "Finish me");
    const worker = await world.startWorker({ webUrl: `http://127.0.0.1:${port}/x`, outboxPollMs: 30, timeoutMs: 3000 });
    await sleep(250); // the request is on its way
    const started = Date.now();
    await worker.stop();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250); // it waited for the answer
    expect(await isDispatched(id, version)).toBe(true); // and noted it
    answerAfterMs = 0;
    delayed.close();
    delayed.closeAllConnections();
  });
});

describe("tidying up", () => {
  it("removes old repeat-protection keys and old finished notes, and nothing else", async () => {
    const [user] = await world.db.insert(users).values({ email: "tidy@example.com", passwordHash: "x" }).returning();
    const userId = user?.id ?? "";
    await world.db.insert(idempotencyKeys).values([
      { userId, key: "old-key-0001", requestHash: "h" },
      { userId, key: "new-key-0001", requestHash: "h" },
    ]);
    await world.pool.query("UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE key = 'old-key-0001'");

    const id = await makeEvent("Tidy");
    for (const title of ["a", "b", "c"]) await edit(id, title);
    const notes = await world.db.select().from(outbox).where(eq(outbox.eventId, id));
    const [oldDone, recentDone, notDone] = notes.sort((x, y) => x.id - y.id);
    await world.pool.query("UPDATE outbox SET dispatched_at = now() - interval '8 days' WHERE id = $1", [oldDone?.id]);
    await world.pool.query("UPDATE outbox SET dispatched_at = now() - interval '1 day' WHERE id = $1", [recentDone?.id]);

    const removed = await cleanOldRecords(world.db);
    expect(removed).toEqual({ keys: 1, notes: 1 });
    const keys = (await world.db.select().from(idempotencyKeys)).map((k) => k.key);
    expect(keys).toEqual(["new-key-0001"]);
    const left = (await world.db.select().from(outbox).where(eq(outbox.eventId, id))).map((n) => n.id).sort();
    expect(left).toEqual([recentDone?.id, notDone?.id].sort());
  });
});
