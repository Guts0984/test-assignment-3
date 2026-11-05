import { randomUUID } from "node:crypto";
import { events, users } from "@app/db";
import { INTERNAL_IP_HEADER, INTERNAL_SIGNATURE_HEADER, INTERNAL_TIMESTAMP_HEADER, signInternalRequest } from "@app/shared/internal";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/app";
import { createLogger } from "../src/infra/logger";
import { createRateLimiter } from "../src/infra/rate-limiter";
import { startStack, TEST_INTERNAL_SECRET, type Stack } from "./helpers/stack";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack.close();
});
beforeEach(async () => {
  await stack.redis.flushall();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ipOf = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

const rules = (overrides: Partial<AppConfig["rateLimit"]> = {}): Partial<AppConfig> => ({
  rateLimit: {
    general: { max: 5, windowSeconds: 60 },
    loginPerIp: { max: 1000, windowSeconds: 900 },
    loginPerEmail: { max: 1000, windowSeconds: 900 },
    ...overrides,
  },
});

/** Asks like a request that came through nginx from this visitor address. */
const fromVisitor = (app: import("express").Express, ip: string, path = "/cities") =>
  request(app).get(path).set("X-Forwarded-For", ip);

describe("the general limit", () => {
  it("lets through the allowed number, then refuses with 429 and says how long to wait", async () => {
    const { app } = await stack.makeInstance(rules());
    const ip = ipOf();
    const remaining: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await fromVisitor(app, ip);
      expect(res.status).toBe(200);
      remaining.push(res.headers["ratelimit-remaining"] as string);
    }
    expect(remaining).toEqual(["4", "3", "2", "1", "0"]);

    const refused = await fromVisitor(app, ip);
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe("RATE_LIMITED");
    expect(typeof refused.body.message).toBe("string");
    const wait = Number(refused.headers["retry-after"]);
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(60);
    expect(refused.body.details.retryAfterSeconds).toBe(wait);
    expect(refused.headers["ratelimit-limit"]).toBe("5");
  });

  it("counts each visitor address separately", async () => {
    const { app } = await stack.makeInstance(rules());
    const [a, b] = [ipOf(), "198.51.100.9"];
    for (let i = 0; i < 6; i += 1) await fromVisitor(app, a);
    expect((await fromVisitor(app, a)).status).toBe(429);
    expect((await fromVisitor(app, b)).status).toBe(200);
  });

  it("is shared by both api instances: the count does not restart on the other one", async () => {
    const [one, two] = [await stack.makeInstance(rules()), await stack.makeInstance(rules())];
    const ip = ipOf();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) statuses.push((await fromVisitor(i % 2 === 0 ? one.app : two.app, ip)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
  });

  it("counts exactly right when requests arrive at the same moment", async () => {
    const [one, two] = [await stack.makeInstance(rules({ general: { max: 40, windowSeconds: 60 } })), await stack.makeInstance(rules({ general: { max: 40, windowSeconds: 60 } }))];
    const ip = ipOf();
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => fromVisitor(i % 2 === 0 ? one.app : two.app, ip)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(40);
    expect(results.filter((r) => r.status === 429)).toHaveLength(60);
  });

  it("never limits the health checks, so Docker can always ask", async () => {
    const { app } = await stack.makeInstance(rules());
    const ip = ipOf();
    for (let i = 0; i < 10; i += 1) await fromVisitor(app, ip);
    expect((await fromVisitor(app, ip)).status).toBe(429);
    expect((await fromVisitor(app, ip, "/health")).status).toBe(200);
    expect((await fromVisitor(app, ip, "/ready")).status).toBe(200);
  });

  it("starts counting again when the window is over", async () => {
    const { app } = await stack.makeInstance(rules({ general: { max: 2, windowSeconds: 1 } }));
    const ip = ipOf();
    await fromVisitor(app, ip);
    await fromVisitor(app, ip);
    expect((await fromVisitor(app, ip)).status).toBe(429);
    await sleep(1300);
    expect((await fromVisitor(app, ip)).status).toBe(200);
  });

  it("a counter can never live forever: every key has an expiry", async () => {
    const { app } = await stack.makeInstance(rules());
    await fromVisitor(app, ipOf());
    const keys = await stack.redis.keys("rl:*");
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(await stack.redis.ttl(key)).toBeGreaterThan(0);
  });
});

describe("a browser cannot choose the address it is counted under (assignment check 21)", () => {
  it("ignores an address header sent without a valid signature", async () => {
    const { app } = await stack.makeInstance(rules());
    const real = ipOf();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await request(app).get("/cities").set("X-Forwarded-For", real).set(INTERNAL_IP_HEADER, `10.9.8.${i}`);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it("ignores a signature made with the wrong secret", async () => {
    const { app } = await stack.makeInstance(rules());
    const real = ipOf();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const forged = signInternalRequest("not-the-real-secret-not-the-real-secret", `10.9.8.${i}`);
      statuses.push((await request(app).get("/cities").set("X-Forwarded-For", real).set(forged)).status);
    }
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it("ignores a real signature that is too old, or whose address was swapped", async () => {
    const { app } = await stack.makeInstance(rules({ general: { max: 3, windowSeconds: 60 } }));
    const real = ipOf();
    const old = signInternalRequest(TEST_INTERNAL_SECRET, "10.0.0.1", Date.now() - 10 * 60 * 1000);
    const swapped = { ...signInternalRequest(TEST_INTERNAL_SECRET, "10.0.0.2"), [INTERNAL_IP_HEADER]: "10.0.0.3" };
    const statuses: number[] = [];
    for (const headers of [old, swapped, old, swapped, old]) {
      statuses.push((await request(app).get("/cities").set("X-Forwarded-For", real).set(headers)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]); // all counted under the real address
  });

  it("uses the address nginx added, not what the browser put in front of it", async () => {
    const { app } = await stack.makeInstance(rules());
    const real = ipOf();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await request(app).get("/cities").set("X-Forwarded-For", `6.6.6.${i}, ${real}`)).status);
    }
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it("without any forwarding header, counts the connection itself", async () => {
    const { app } = await stack.makeInstance(rules());
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await request(app).get("/cities")).status);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe("calls from our own web server", () => {
  it("are counted under the visitor they speak for, each visitor separately", async () => {
    const { app } = await stack.makeInstance(rules());
    const call = (ip: string) => request(app).get("/cities").set(signInternalRequest(TEST_INTERNAL_SECRET, ip));
    for (let i = 0; i < 5; i += 1) expect((await call("192.0.2.10")).status).toBe(200);
    expect((await call("192.0.2.10")).status).toBe(429);
    expect((await call("192.0.2.11")).status).toBe(200);
  });

  it("when made for no particular visitor (cached page data) do not use up anybody's allowance", async () => {
    const { app } = await stack.makeInstance(rules());
    for (let i = 0; i < 50; i += 1) {
      const res = await request(app).get("/cities").set(signInternalRequest(TEST_INTERNAL_SECRET));
      expect(res.status).toBe(200);
    }
    // and the connection's own address (the web server's) has not been charged either
    expect((await request(app).get("/cities")).status).toBe(200);
  });

  it("the signature only counts for the address it was made for", async () => {
    const { app } = await stack.makeInstance(rules());
    const forVisitorA = signInternalRequest(TEST_INTERNAL_SECRET, "192.0.2.50");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await request(app).get("/cities").set(forVisitorA)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    // not the visitor from the signature, so nothing changes for the other
    expect((await request(app).get("/cities").set("X-Forwarded-For", "192.0.2.51")).status).toBe(200);
  });
});

describe("guessing ids that do not exist (assignment check 10)", () => {
  it("is cut off by the limit, and the database is asked no more than the limit allows", async () => {
    const config: Partial<AppConfig> = { rateLimit: { general: { max: 300, windowSeconds: 60 }, loginPerIp: { max: 100000, windowSeconds: 900 }, loginPerEmail: { max: 100000, windowSeconds: 900 } } };
    const [one, two] = [await stack.makeInstance(config), await stack.makeInstance(config)];
    await stack.db.delete(events).catch(() => undefined);
    const ip = ipOf();

    const counter = stack.countQueries(/from "events"/i);
    const statuses: number[] = [];
    for (let batch = 0; batch < 10; batch += 1) {
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          request((batch * 100 + i) % 2 === 0 ? one.app : two.app).get(`/events/${500_000 + batch * 100 + i}`).set("X-Forwarded-For", ip),
        ),
      );
      statuses.push(...results.map((r) => r.status));
    }
    counter.stop();

    expect(statuses.filter((s) => s === 404)).toHaveLength(300);
    expect(statuses.filter((s) => s === 429)).toHaveLength(700);
    expect(statuses.every((s) => s === 404 || s === 429)).toBe(true);
    expect(counter.count()).toBeLessThanOrEqual(300);
  });
});

describe("logging in: stricter limits (assignment check 22)", () => {
  const password = "correct-horse-1";
  const attempt = (app: import("express").Express, email: string, pass: string, ip = "192.0.2.77") =>
    request(app).post("/auth/login").set("X-Forwarded-For", ip).send({ email, password: pass });
  const loginRules = (perIp = 1000, perEmail = 5, windowSeconds = 900) =>
    rules({ general: { max: 100000, windowSeconds: 60 }, loginPerIp: { max: perIp, windowSeconds }, loginPerEmail: { max: perEmail, windowSeconds } });

  beforeEach(async () => {
    await stack.db.delete(users);
    const { app } = await stack.makeInstance();
    await request(app).post("/auth/register").send({ email: "alice@example.com", password });
    await request(app).post("/auth/register").send({ email: "bob@example.com", password });
    await stack.redis.flushall();
  });

  it("10 wrong passwords in a row for one email: the first 5 are answered, the rest are refused", async () => {
    const { app } = await stack.makeInstance(loginRules());
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) statuses.push((await attempt(app, "alice@example.com", `wrong-${i}-password`)).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429, 429, 429]);
  });

  it("while locked, even the right password is refused, and no cookie is given", async () => {
    const { app } = await stack.makeInstance(loginRules());
    for (let i = 0; i < 5; i += 1) await attempt(app, "alice@example.com", "wrong-password-1");
    const res = await attempt(app, "alice@example.com", password);
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/this account/i);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("an email that is not registered is locked in exactly the same way, so nothing is revealed", async () => {
    const { app } = await stack.makeInstance(loginRules());
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await attempt(app, "nobody@example.com", "wrong-password-1")).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });

  it("a correct password clears the count, so honest typos never add up", async () => {
    const { app } = await stack.makeInstance(loginRules());
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 4; i += 1) expect((await attempt(app, "alice@example.com", "wrong-password-1")).status).toBe(401);
      expect((await attempt(app, "alice@example.com", password)).status).toBe(200);
    }
  });

  it("the same account written differently shares one count", async () => {
    const { app } = await stack.makeInstance(loginRules());
    for (const written of ["alice@example.com", "ALICE@example.com", " Alice@Example.com ", "alice@EXAMPLE.com", "alice@example.com"]) {
      expect((await attempt(app, written, "wrong-password-1")).status).toBe(401);
    }
    expect((await attempt(app, "AlIcE@example.com", "wrong-password-1")).status).toBe(429);
  });

  it("locking one account does not lock another", async () => {
    const { app } = await stack.makeInstance(loginRules());
    for (let i = 0; i < 6; i += 1) await attempt(app, "alice@example.com", "wrong-password-1");
    expect((await attempt(app, "bob@example.com", password)).status).toBe(200);
  });

  it("the count is shared by both api instances", async () => {
    const [one, two] = [await stack.makeInstance(loginRules()), await stack.makeInstance(loginRules())];
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await attempt(i % 2 === 0 ? one.app : two.app, "alice@example.com", "wrong-password-1")).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });

  it("20 guesses at once for one account: exactly 5 are answered", async () => {
    const [one, two] = [await stack.makeInstance(loginRules()), await stack.makeInstance(loginRules())];
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => attempt(i % 2 === 0 ? one.app : two.app, "alice@example.com", `guess-${i}-password`)),
    );
    expect(results.filter((r) => r.status === 401)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(15);
  });

  it("one address trying many accounts is stopped too, and other addresses are not affected", async () => {
    const { app } = await stack.makeInstance(loginRules(3, 100));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await attempt(app, `person${i}@example.com`, "wrong-password-1", "192.0.2.90")).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    const res = await attempt(app, "alice@example.com", password, "192.0.2.91");
    expect(res.status).toBe(200);
    expect((await attempt(app, "alice@example.com", password, "192.0.2.90")).body.message).toMatch(/this address/i);
  });

  it("the lock ends when its window ends", async () => {
    const { app } = await stack.makeInstance(loginRules(1000, 2, 1));
    await attempt(app, "alice@example.com", "wrong-password-1");
    await attempt(app, "alice@example.com", "wrong-password-1");
    expect((await attempt(app, "alice@example.com", password)).status).toBe(429);
    await sleep(1300);
    expect((await attempt(app, "alice@example.com", password)).status).toBe(200);
  });

  it("no email address is written into Redis in the clear", async () => {
    const { app } = await stack.makeInstance(loginRules());
    await attempt(app, "alice@example.com", "wrong-password-1");
    const keys = await stack.redis.keys("rl:login:*");
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join(" ")).not.toContain("alice");
  });
});

describe("when Redis fails", () => {
  it("requests are let through rather than refused", async () => {
    const broken = { eval: () => Promise.reject(new Error("redis is down")), del: () => Promise.reject(new Error("redis is down")) };
    const limiter = createRateLimiter(broken, createLogger("silent"));
    const result = await limiter.consume("ip:1.2.3.4", { max: 1, windowSeconds: 60 });
    expect(result.allowed).toBe(true);
    await expect(limiter.reset("x")).resolves.toBeUndefined();
  });
});

void randomUUID;
void INTERNAL_SIGNATURE_HEADER;
void INTERNAL_TIMESTAMP_HEADER;
