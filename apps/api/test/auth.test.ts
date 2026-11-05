import { users } from "@app/db";
import { seedIfEmpty } from "@app/db/seed";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startStack, type Stack } from "./helpers/stack";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ sessionTtlSeconds: 3600 });
});
afterAll(async () => {
  await stack.close();
});
beforeEach(async () => {
  await stack.db.delete(users);
  await stack.redis.flushall();
});

const password = "correct-horse-1";
const credentials = (email = "alice@example.com", pass = password) => ({ email, password: pass });
const register = (email?: string, pass?: string, app: Express = stack.app) =>
  request(app).post("/auth/register").send(credentials(email, pass));
const login = (email?: string, pass?: string, app: Express = stack.app) =>
  request(app).post("/auth/login").send(credentials(email, pass));

const setCookies = (res: request.Response): string[] => {
  const header = res.headers["set-cookie"] as string[] | string | undefined;
  return header === undefined ? [] : Array.isArray(header) ? header : [header];
};
/** "sid=abc" part of the Set-Cookie header, ready to send back as a Cookie header. */
const sessionCookie = (res: request.Response): string => {
  const line = setCookies(res).find((c) => c.startsWith("sid="));
  if (!line) throw new Error("no session cookie was set");
  return line.split(";")[0] ?? "";
};
const sessionKeys = () => stack.redis.keys("sess:*");

describe("register", () => {
  it("creates the account, logs in, and returns only the public user", async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(["email", "id", "role"]);
    expect(res.body).toMatchObject({ email: "alice@example.com", role: "user" });
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|passwordHash|password/i);
  });

  it("sets a cookie that page scripts cannot read, and that other sites cannot send in forms", async () => {
    const res = await register();
    const cookie = setCookies(res).find((c) => c.startsWith("sid=")) ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=3600/);
    expect(cookie).not.toMatch(/Secure/i); // plain http on localhost
  });

  it("marks the cookie Secure when the site is served over https", async () => {
    const secureApp = (await stack.makeInstance({ cookieSecure: true })).app;
    const res = await register("secure@example.com", password, secureApp);
    expect(setCookies(res).find((c) => c.startsWith("sid="))).toMatch(/Secure/i);
  });

  it("stores an argon2 hash, never the password, and creates a plain user", async () => {
    await register();
    const [row] = await stack.db.select().from(users);
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.passwordHash).not.toContain(password);
    expect(row?.role).toBe("user");
  });

  it("the new account is logged in: /me works with the cookie from registration", async () => {
    const res = await register();
    const me = await request(stack.app).get("/me").set("Cookie", sessionCookie(res));
    expect(me.status).toBe(200);
    expect(me.body).toEqual(res.body);
  });

  it("refuses an address that is already registered, whatever its letter case or spacing", async () => {
    await register("alice@example.com");
    for (const again of ["alice@example.com", "ALICE@EXAMPLE.COM", "  Alice@Example.com  "]) {
      const res = await register(again);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("EMAIL_TAKEN");
    }
    expect(await stack.db.select().from(users)).toHaveLength(1);
  });

  it("when 20 people register the same address at once, exactly one wins", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => register("race@example.com")));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    expect(await stack.db.select().from(users)).toHaveLength(1);
    expect(await sessionKeys()).toHaveLength(1); // the 19 losers did not get a session
  });

  it("does not let a visitor choose their own role", async () => {
    const res = await request(stack.app)
      .post("/auth/register")
      .send({ email: "mallory@example.com", password, role: "admin" });
    expect(res.status).toBe(400);
    expect(await stack.db.select().from(users)).toHaveLength(0);
    expect(setCookies(res)).toEqual([]);
  });

  it("explains validation problems per field in plain words", async () => {
    const res = await request(stack.app).post("/auth/register").send({ email: "nope", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details.fields).toEqual({
      email: ["Email must be a valid email address"],
      password: ["Password must be at least 8 characters"],
    });
  });

  it("rejects an empty body and a body of the wrong type", async () => {
    expect((await request(stack.app).post("/auth/register")).status).toBe(400);
    expect((await request(stack.app).post("/auth/register").send([1, 2])).status).toBe(400);
    expect((await request(stack.app).post("/auth/register").set("Content-Type", "text/plain").send("hello")).status).toBe(400);
  });

  it("keeps spaces at the ends of the password", async () => {
    await register("spaces@example.com", "  padded pass  ");
    expect((await login("spaces@example.com", "  padded pass  ")).status).toBe(200);
    expect((await login("spaces@example.com", "padded pass")).status).toBe(401);
  });
});

describe("login", () => {
  beforeEach(async () => {
    await register();
    await stack.redis.flushall();
  });

  it("logs in with the right password and starts a new session", async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: "alice@example.com", role: "user" });
    expect(await sessionKeys()).toHaveLength(1);
    expect((await request(stack.app).get("/me").set("Cookie", sessionCookie(res))).status).toBe(200);
  });

  it("ignores letter case and spaces in the email", async () => {
    expect((await login("  ALICE@Example.COM ")).status).toBe(200);
  });

  it("refuses a wrong password, and sets no cookie", async () => {
    const res = await login("alice@example.com", "wrong-password-1");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_CREDENTIALS");
    expect(setCookies(res)).toEqual([]);
    expect(await sessionKeys()).toHaveLength(0);
  });

  it("gives the very same answer for an unknown email, so it does not reveal who is registered", async () => {
    const wrongPassword = await login("alice@example.com", "wrong-password-1");
    const unknownEmail = await login("nobody@example.com", "wrong-password-1");
    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it("does not log in with the stored hash used as a password", async () => {
    const [row] = await stack.db.select().from(users);
    expect((await login("alice@example.com", row?.passwordHash)).status).toBe(401);
  });

  it("two logins make two independent sessions", async () => {
    const [a, b] = [await login(), await login()];
    expect(sessionCookie(a)).not.toBe(sessionCookie(b));
    expect(await sessionKeys()).toHaveLength(2);
  });

  it("rejects extra fields and missing fields", async () => {
    expect((await request(stack.app).post("/auth/login").send({ email: "alice@example.com" })).status).toBe(400);
    expect((await request(stack.app).post("/auth/login").send({ ...credentials(), role: "admin" })).status).toBe(400);
  });
});

describe("demo users from the seed", () => {
  it("the admin can log in and is an admin; the others are plain users", async () => {
    await seedIfEmpty(stack.db, {
      passwords: { admin: "Admin-Demo-Pass-1", alice: "Alice-Demo-Pass-1", bob: "Bob-Demo-Pass-1" },
      now: new Date(),
    });
    const admin = await login("admin@example.com", "Admin-Demo-Pass-1");
    expect(admin.status).toBe(200);
    expect(admin.body.role).toBe("admin");
    const alice = await login("alice@example.com", "Alice-Demo-Pass-1");
    expect(alice.body.role).toBe("user");
    expect((await login("alice@example.com", "Admin-Demo-Pass-1")).status).toBe(401);
  });
});

describe("/me", () => {
  it("is 401 without a cookie, with a made-up cookie, and with the wrong cookie name", async () => {
    expect((await request(stack.app).get("/me")).status).toBe(401);
    expect((await request(stack.app).get("/me").set("Cookie", `sid=${"A".repeat(43)}`)).status).toBe(401);
    const reg = await register();
    const value = sessionCookie(reg).split("=")[1] ?? "";
    expect((await request(stack.app).get("/me").set("Cookie", `session=${value}`)).status).toBe(401);
  });

  it("answers 401 in the standard error shape", async () => {
    const res = await request(stack.app).get("/me");
    expect(res.body).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(typeof res.body.message).toBe("string");
  });

  it("is 401 once the session has expired in Redis", async () => {
    const res = await register();
    await stack.redis.del(...(await sessionKeys()));
    expect((await request(stack.app).get("/me").set("Cookie", sessionCookie(res))).status).toBe(401);
  });

  it("is 401 if the user was deleted while the session still exists", async () => {
    const res = await register();
    await stack.db.delete(users);
    expect((await request(stack.app).get("/me").set("Cookie", sessionCookie(res))).status).toBe(401);
  });

  it("shows a role change at once (the role is not copied into the session)", async () => {
    const res = await register();
    await stack.db.update(users).set({ role: "admin" }).where(eq(users.email, "alice@example.com"));
    const me = await request(stack.app).get("/me").set("Cookie", sessionCookie(res));
    expect(me.body.role).toBe("admin");
  });

  it("keeps two users apart", async () => {
    const [a, b] = [await register("a@example.com"), await register("b@example.com")];
    const meA = await request(stack.app).get("/me").set("Cookie", sessionCookie(a));
    const meB = await request(stack.app).get("/me").set("Cookie", sessionCookie(b));
    expect(meA.body.email).toBe("a@example.com");
    expect(meB.body.email).toBe("b@example.com");
  });
});

describe("logout", () => {
  it("ends the session at once: the old cookie stops working", async () => {
    const reg = await register();
    const cookie = sessionCookie(reg);
    const out = await request(stack.app).post("/auth/logout").set("Cookie", cookie);
    expect(out.status).toBe(204);
    expect((await request(stack.app).get("/me").set("Cookie", cookie)).status).toBe(401);
    expect(await sessionKeys()).toHaveLength(0);
  });

  it("clears the cookie in the browser", async () => {
    const reg = await register();
    const out = await request(stack.app).post("/auth/logout").set("Cookie", sessionCookie(reg));
    const cleared = setCookies(out).find((c) => c.startsWith("sid=")) ?? "";
    expect(cleared).toMatch(/sid=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it("is fine without a cookie and when repeated", async () => {
    expect((await request(stack.app).post("/auth/logout")).status).toBe(204);
    const reg = await register();
    const cookie = sessionCookie(reg);
    expect((await request(stack.app).post("/auth/logout").set("Cookie", cookie)).status).toBe(204);
    expect((await request(stack.app).post("/auth/logout").set("Cookie", cookie)).status).toBe(204);
  });

  it("ends only this session: the same user stays logged in on another device", async () => {
    await register();
    const [laptop, phone] = [await login(), await login()];
    await request(stack.app).post("/auth/logout").set("Cookie", sessionCookie(laptop));
    expect((await request(stack.app).get("/me").set("Cookie", sessionCookie(laptop))).status).toBe(401);
    expect((await request(stack.app).get("/me").set("Cookie", sessionCookie(phone))).status).toBe(200);
  });

  it("with a cookie of someone else's malformed value, does not touch other sessions", async () => {
    const reg = await register();
    await request(stack.app).post("/auth/logout").set("Cookie", "sid=*");
    expect((await request(stack.app).get("/me").set("Cookie", sessionCookie(reg))).status).toBe(200);
  });
});

describe("two api instances", () => {
  it("a login on one instance is valid on the other, and a logout on one kills it on both", async () => {
    const api1 = (await stack.makeInstance()).app;
    const api2 = (await stack.makeInstance()).app;
    const reg = await register("shared@example.com", password, api1);
    const cookie = sessionCookie(reg);

    expect((await request(api2).get("/me").set("Cookie", cookie)).status).toBe(200);
    await request(api2).post("/auth/logout").set("Cookie", cookie);
    expect((await request(api1).get("/me").set("Cookie", cookie)).status).toBe(401);
  });
});

describe("requests made by other websites", () => {
  it("blocks a login or logout that a page on another site sent", async () => {
    const res = await request(stack.app)
      .post("/auth/login")
      .set("Origin", "http://evil.example")
      .send(credentials());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(setCookies(res)).toEqual([]);

    const out = await request(stack.app).post("/auth/logout").set("Origin", "http://evil.example");
    expect(out.status).toBe(403);
  });

  it("allows the site's own pages, and requests that carry no Origin", async () => {
    await register();
    const own = await request(stack.app)
      .post("/auth/login")
      .set("Host", "localhost:8080")
      .set("Origin", "http://localhost:8080")
      .send(credentials());
    expect(own.status).toBe(200);
    expect((await login()).status).toBe(200);
  });

  it("blocks an Origin that only looks similar", async () => {
    const res = await request(stack.app)
      .post("/auth/login")
      .set("Host", "localhost:8080")
      .set("Origin", "http://localhost:8080.evil.example")
      .send(credentials());
    expect(res.status).toBe(403);
  });
});

describe("documentation", () => {
  it("lists the auth endpoints on /openapi.json", async () => {
    const res = await request(stack.app).get("/openapi.json");
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(["/auth/register", "/auth/login", "/auth/logout", "/me"]),
    );
    expect(res.body.paths["/auth/register"].post.requestBody.content["application/json"].schema.additionalProperties).toBe(false);
  });
});
