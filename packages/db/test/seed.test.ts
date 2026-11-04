import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedIfEmpty } from "../src/seed";
import { EVENT_COUNT, SEED_WINDOW_DAYS, generateEvents } from "../src/seed/generate-events";
import { startTestDb, type TestDb } from "./helpers";

let t: TestDb;
const passwords = { admin: "admin-pass-1", alice: "alice-pass-1", bob: "bob-pass-1" };

beforeAll(async () => {
  t = await startTestDb(5);
});
afterAll(async () => {
  await t.stop();
});

describe("seed", () => {
  it("creates 200 events in 8 cities within the next 3 months and 3 users, one admin", async () => {
    const now = new Date();
    const added = await seedIfEmpty(t.db, { passwords, now });
    expect(added).toEqual({ users: 3, events: EVENT_COUNT });

    const stats = await t.pool.query<{ events: string; cities: string; first: Date; last: Date }>(
      "SELECT count(*) AS events, count(DISTINCT city) AS cities, min(starts_at) AS first, max(starts_at) AS last FROM events",
    );
    const row = stats.rows[0];
    expect(Number(row?.events)).toBe(200);
    expect(Number(row?.cities)).toBe(8);
    expect(row?.first.getTime()).toBeGreaterThan(now.getTime());
    expect(row?.last.getTime()).toBeLessThanOrEqual(now.getTime() + SEED_WINDOW_DAYS * 86_400_000);

    const roles = await t.pool.query<{ role: string; count: string }>(
      "SELECT role, count(*) FROM users GROUP BY role ORDER BY role::text",
    );
    expect(roles.rows.map((r) => [r.role, Number(r.count)])).toEqual([
      ["admin", 1],
      ["user", 2],
    ]);
  });

  it("stores argon2 hashes, not passwords", async () => {
    const result = await t.pool.query<{ password_hash: string }>("SELECT password_hash FROM users");
    expect(result.rows.every((r) => r.password_hash.startsWith("$argon2"))).toBe(true);
  });

  it("running it again changes nothing", async () => {
    const added = await seedIfEmpty(t.db, { passwords });
    expect(added).toEqual({ users: 0, events: 0 });
    const count = await t.pool.query<{ n: string }>("SELECT count(*) AS n FROM events");
    expect(Number(count.rows[0]?.n)).toBe(200);
  });
});

describe("generateEvents", () => {
  it("is deterministic for the same time", () => {
    const now = new Date("2026-11-04T10:00:00Z");
    expect(generateEvents(now)).toEqual(generateEvents(now));
  });
});
