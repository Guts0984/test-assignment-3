import { bookings, events, users, type NewEvent } from "@app/db";
import { generateEvents } from "@app/db/seed";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack, type Stack } from "./helpers/stack";

let stack: Stack;
const NOW = new Date("2026-11-10T09:00:00Z");

beforeAll(async () => {
  stack = await startStack();
  await stack.db.insert(events).values(generateEvents(NOW));
});
afterAll(async () => {
  await stack.close();
});

const get = (path: string) => request(stack.app).get(path);
const allRows = () => stack.db.select().from(events);
const byTimeThenId = (a: { startsAt: string; id: number }, b: { startsAt: string; id: number }) =>
  a.startsAt.localeCompare(b.startsAt) || a.id - b.id;

interface Item {
  id: number;
  title: string;
  description: string;
  city: string;
  venue: string;
  startsAt: string;
  capacity: number;
  version: number;
  updatedAt: string;
}
interface Page {
  items: Item[];
  nextCursor: string | null;
}

/** Follows nextCursor until the end, returning every item in the order received. */
async function walk(query: string, limit: number): Promise<{ items: Item[]; pages: number }> {
  const items: Item[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res: request.Response = await get(`/events?${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
    expect(res.status).toBe(200);
    const page = res.body as Page;
    items.push(...page.items);
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 500) throw new Error("pagination never ends");
  } while (cursor);
  return { items, pages };
}

describe("GET /events: pages", () => {
  it("returns 20 events by default, each with exactly the public fields", async () => {
    const res = await get("/events");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(20);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(
      ["capacity", "city", "description", "id", "startsAt", "title", "updatedAt", "venue", "version"],
    );
    expect(res.body.nextCursor).toEqual(expect.any(String));
  });

  it("is sorted by start time, then id", async () => {
    const items = (await get("/events?limit=50")).body.items as Item[];
    expect([...items].sort(byTimeThenId)).toEqual(items);
  });

  it("walking all pages gives every event exactly once, in order", async () => {
    const { items, pages } = await walk("", 7);
    const rows = await allRows();
    expect(items).toHaveLength(200);
    expect(new Set(items.map((i) => i.id)).size).toBe(200);
    expect(new Set(items.map((i) => i.id))).toEqual(new Set(rows.map((r) => r.id)));
    expect([...items].sort(byTimeThenId)).toEqual(items);
    expect(pages).toBe(Math.ceil(200 / 7));
  });

  it("the last page has no cursor, and a page that exactly fills the limit does not invent one", async () => {
    const exact = await get("/events?limit=50&city=London"); // 25 London events: fewer than the limit
    expect(exact.body.items).toHaveLength(25);
    expect(exact.body.nextCursor).toBeNull();
    const split = await walk("city=London", 25); // limit equals the total: still just one page
    expect(split.pages).toBe(1);
  });

  it("events that start at the very same moment are neither skipped nor repeated between pages", async () => {
    const sameMoment = new Date("2030-01-01T10:00:00Z");
    const rows: NewEvent[] = Array.from({ length: 11 }, (_, i) => ({
      title: `Tie ${i}`,
      description: "same start",
      city: "Tieville",
      venue: "Hall",
      startsAt: sameMoment,
      capacity: 10,
    }));
    await stack.db.insert(events).values(rows);

    const { items } = await walk("city=Tieville", 3);
    expect(items).toHaveLength(11);
    expect(new Set(items.map((i) => i.id)).size).toBe(11);
    expect(items.map((i) => i.id)).toEqual([...items.map((i) => i.id)].sort((a, b) => a - b));
    await stack.db.delete(events).where(eq(events.city, "Tieville"));
  });

  it.each([
    ["0", 400],
    ["51", 400],
    ["-3", 400],
    ["abc", 400],
    ["1.5", 400],
    ["1", 200],
    ["50", 200],
  ])("limit=%s -> %i", async (limit, status) => {
    expect((await get(`/events?limit=${limit}`)).status).toBe(status);
  });

  it("explains a bad limit in plain words", async () => {
    const res = await get("/events?limit=500");
    expect(res.body.details.fields).toEqual({ limit: ["Limit must be at most 50"] });
  });

  it("treats blank filters as not given", async () => {
    const res = await get("/events?city=&q=&from=&to=&cursor=&limit=");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(20);
  });
});

describe("GET /events: filters", () => {
  it("city: ignores letter case and spaces, and matches only that city", async () => {
    const res = await get("/events?city=%20lOnDoN%20&limit=50");
    const expected = (await allRows()).filter((r) => r.city === "London");
    expect(res.body.items).toHaveLength(expected.length);
    expect(res.body.items.every((i: Item) => i.city === "London")).toBe(true);
  });

  it("an unknown city is an empty page, not an error", async () => {
    const res = await get("/events?city=Atlantis");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it("a plain date range covers whole days at both ends", async () => {
    const rows = await allRows();
    const day = rows[10]?.startsAt.toISOString().slice(0, 10) ?? "";
    const res = await get(`/events?from=${day}&to=${day}&limit=50`);
    const expected = rows.filter((r) => r.startsAt.toISOString().slice(0, 10) === day);
    expect(expected.length).toBeGreaterThan(0);
    expect(new Set(res.body.items.map((i: Item) => i.id))).toEqual(new Set(expected.map((r) => r.id)));
  });

  it("'from' and 'to' with a time include an event that starts at exactly that moment", async () => {
    const [target] = (await allRows()).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).slice(30, 31);
    const at = target?.startsAt.toISOString() ?? "";
    const res = await get(`/events?from=${at}&to=${at}`);
    expect(res.body.items.map((i: Item) => i.id)).toContain(target?.id);
    expect(res.body.items.every((i: Item) => i.startsAt === at)).toBe(true);
  });

  it("a range with no events is an empty page", async () => {
    const res = await get("/events?from=1999-01-01&to=1999-12-31");
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it("rejects an end before the start, and dates that are not dates, in plain words", async () => {
    const backwards = await get("/events?from=2026-12-31&to=2026-01-01");
    expect(backwards.status).toBe(400);
    expect(backwards.body.details.fields.to).toEqual(["The end date must not be before the start date."]);

    for (const bad of ["yesterday", "2026-13-45", "31/12/2026", "2026-02-30"]) {
      const res = await get(`/events?from=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
    }
  });

  it("combines city, dates and search: each narrows the result", async () => {
    const rows = await allRows();
    const london = rows.filter((r) => r.city === "London").sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    const from = london[3]?.startsAt.toISOString() ?? "";
    const res = await get(`/events?city=London&from=${from}&limit=50`);
    expect(res.body.items.length).toBe(london.length - 3);
    expect(res.body.items.every((i: Item) => i.city === "London" && i.startsAt >= from)).toBe(true);
  });
});

describe("GET /events: text search", () => {
  const wordsOf = (row: { title: string; description: string; venue: string }) =>
    `${row.title} ${row.description} ${row.venue}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const expectedIds = async (prefixes: string[]) =>
    new Set(
      (await allRows())
        .filter((row) => prefixes.every((p) => wordsOf(row).some((w) => w.startsWith(p))))
        .map((row) => row.id),
    );
  const searchIds = async (q: string) => new Set((await walk(`q=${encodeURIComponent(q)}`, 50)).items.map((i) => i.id));

  it("finds events by the beginning of a word in title, description or venue", async () => {
    const ids = await searchIds("orch");
    expect(ids.size).toBeGreaterThan(0);
    expect(ids).toEqual(await expectedIds(["orch"]));
  });

  it("ignores letter case", async () => {
    expect(await searchIds("ORCHESTRA")).toEqual(await searchIds("orchestra"));
  });

  it("requires every word (AND)", async () => {
    const both = await searchIds("concert hall");
    expect(both).toEqual(await expectedIds(["concert", "hall"]));
    const one = await searchIds("concert");
    expect(both.size).toBeLessThanOrEqual(one.size);
  });

  it("a word that is nowhere gives an empty page", async () => {
    expect((await get("/events?q=zzzzqqqq")).body.items).toEqual([]);
  });

  it("only punctuation or spaces is the same as no search", async () => {
    const all = await get("/events?limit=50");
    for (const q of ["%20%20", "%26%7C!", "()", "%3A*"]) {
      expect((await get(`/events?limit=50&q=${q}`)).body.items.map((i: Item) => i.id)).toEqual(
        all.body.items.map((i: Item) => i.id),
      );
    }
  });

  it("survives text meant to break a query, and the table is still there afterwards", async () => {
    for (const q of ["'; DROP TABLE events; --", "a & | ! b", "\\", "((((", "a:*b", "<->", "%00", "\u0000x", "x".repeat(100)]) {
      const res = await get(`/events?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
    expect((await allRows()).length).toBeGreaterThanOrEqual(200);
  });

  it("works together with the city filter and with paging", async () => {
    const rows = await allRows();
    const expected = rows.filter((r) => r.city === "Berlin" && wordsOf(r).some((w) => w.startsWith("con")));
    const { items } = await walk("city=Berlin&q=con", 4);
    expect(new Set(items.map((i) => i.id))).toEqual(new Set(expected.map((r) => r.id)));
    expect(items).toHaveLength(expected.length);
  });
});

describe("GET /events: cursor", () => {
  it("rejects a cursor that is not one of ours, in plain words", async () => {
    for (const bad of ["garbage", "e30", "AAAA", "x".repeat(300)]) {
      const res = await get(`/events?cursor=${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.body.details.fields.cursor).toEqual(["The cursor is not valid."]);
    }
  });

  it("a cursor taken from a filtered query keeps working with the same filter, never leaks other cities", async () => {
    const first = await get("/events?city=Paris&limit=5");
    const second = await get(`/events?city=Paris&limit=5&cursor=${first.body.nextCursor}`);
    expect(second.body.items.every((i: Item) => i.city === "Paris")).toBe(true);
    const firstIds = new Set(first.body.items.map((i: Item) => i.id));
    expect(second.body.items.some((i: Item) => firstIds.has(i.id))).toBe(false);
  });

  it("a cursor from the last event of the whole list gives an empty last page", async () => {
    const all = await walk("", 50);
    const last = all.items.at(-1);
    const cursor = Buffer.from(JSON.stringify({ t: last?.startsAt, i: last?.id })).toString("base64url");
    expect((await get(`/events?cursor=${cursor}`)).body).toEqual({ items: [], nextCursor: null });
  });
});

describe("GET /events/:id", () => {
  it("returns the event with its version, and nothing about seats", async () => {
    const [row] = await allRows();
    const res = await get(`/events/${row?.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: row?.id,
      title: row?.title,
      description: row?.description,
      city: row?.city,
      venue: row?.venue,
      startsAt: row?.startsAt.toISOString(),
      capacity: row?.capacity,
      version: 1,
      updatedAt: row?.updatedAt.toISOString(),
    });
    expect(JSON.stringify(res.body)).not.toMatch(/bookedSeats|booked_seats|searchVector/);
  });

  it("404 for an id that does not exist, in the standard error shape", async () => {
    const res = await get("/events/999999");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
    expect(typeof res.body.message).toBe("string");
  });

  it.each(["abc", "0", "-1", "1.5", "1e3", "01", "%205", "0x10", "2147483648", "99999999999999999999", "%D9%A3", "null", "undefined"])(
    "404, not a crash, for the id %s",
    async (id) => {
      const counter = stack.countQueries(/from "events"/i);
      const res = await get(`/events/${id}`);
      counter.stop();
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");
      expect(counter.count()).toBe(0); // an impossible id never reaches the database
    },
  );

  it("the biggest valid id is a normal 404, not a database error", async () => {
    expect((await get("/events/2147483647")).status).toBe(404);
  });
});

describe("GET /events/:id/availability", () => {
  async function makeEvent(capacity: number): Promise<number> {
    const [row] = await stack.db
      .insert(events)
      .values({ title: "Seats", description: "d", city: "Seatown", venue: "v", startsAt: new Date("2031-01-01T10:00:00Z"), capacity })
      .returning();
    if (!row) throw new Error("no event");
    return row.id;
  }
  async function makeUser(email: string): Promise<string> {
    const [row] = await stack.db.insert(users).values({ email, passwordHash: "x" }).returning();
    if (!row) throw new Error("no user");
    return row.id;
  }
  const hold = (userId: string, eventId: number, quantity: number, status: "held" | "confirmed" = "held") =>
    stack.db
      .insert(bookings)
      .values({ userId, eventId, quantity, status, expiresAt: new Date(Date.now() + 600_000) })
      .returning();

  it("is the capacity minus seats that are held or confirmed", async () => {
    const id = await makeEvent(10);
    const user = await makeUser("seats1@example.com");
    await hold(user, id, 3, "held");
    await hold(user, id, 2, "confirmed");
    const [cancelled] = await hold(user, id, 4, "held");
    await stack.db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, cancelled?.id ?? ""));

    const res = await get(`/events/${id}/availability`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eventId: id, capacity: 10, available: 5 });
  });

  it("is never older than one second", async () => {
    const id = await makeEvent(10);
    const user = await makeUser("seats2@example.com");
    expect((await get(`/events/${id}/availability`)).body.available).toBe(10);

    await hold(user, id, 4);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await get(`/events/${id}/availability`)).body.available).toBe(6);
  });

  it("answers many callers in the same second with one database read", async () => {
    const id = await makeEvent(10);
    await get(`/events/${id}`); // load the event itself first, so only the seats query remains
    const counter = stack.countQueries(/"booked_seats"/i);
    await Promise.all(Array.from({ length: 40 }, () => get(`/events/${id}/availability`)));
    counter.stop();
    expect(counter.count()).toBe(1);
  });

  it("404 for an event that does not exist, and no seats query is made", async () => {
    const counter = stack.countQueries(/"booked_seats"/i);
    const res = await get("/events/888888/availability");
    counter.stop();
    expect(res.status).toBe(404);
    expect(counter.count()).toBe(0);
    expect((await get("/events/abc/availability")).status).toBe(404);
  });
});

describe("GET /cities", () => {
  it("lists each city once, sorted", async () => {
    const res = await get("/cities");
    expect(res.status).toBe(200);
    const expected = [...new Set((await allRows()).map((r) => r.city))].sort();
    expect(res.body).toEqual(expect.arrayContaining(["London", "Berlin", "Paris", "Prague"]));
    expect(res.body.filter((c: string) => expected.includes(c))).toEqual(
      [...res.body].filter((c: string) => expected.includes(c)).sort(),
    );
    expect(new Set(res.body).size).toBe(res.body.length);
  });
});

describe("documentation", () => {
  it("lists the events endpoints with their query parameters", async () => {
    const res = await get("/openapi.json");
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(["/events", "/events/{id}", "/events/{id}/availability", "/cities"]),
    );
    const names = res.body.paths["/events"].get.parameters.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(["city", "q", "from", "to", "cursor", "limit"]));
  });

  it("tells the reader how to log in on the docs page, because the Authorize box cannot set a cookie", async () => {
    const res = await get("/openapi.json");
    expect(res.body.info.description).toContain("POST /auth/login");
    expect(res.body.components.securitySchemes.sessionCookie.description).toContain("POST /auth/login");
  });
});
