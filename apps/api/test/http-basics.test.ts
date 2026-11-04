import { Writable } from "node:stream";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLogger } from "../src/infra/logger";
import { createAccessLog } from "../src/middleware/access-log";
import { createErrorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import { pickRequestId, requestId } from "../src/middleware/request-id";
import { validated } from "../src/middleware/validate";
import { createAppError } from "../src/lib/app-error";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(...chunk.toString().trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>));
      done();
    },
  });
  return { lines, logger: createLogger("debug", stream) };
}

function buildApp() {
  const { lines, logger } = capture();
  const app = express();
  app.use(requestId);
  app.use(createAccessLog(logger));
  app.use(express.json({ limit: "1kb" }));

  app.post(
    "/things/:id",
    validated(
      {
        params: z.object({ id: z.string().regex(/^[1-9]\d*$/, "Must be a positive whole number") }),
        body: z.object({ title: z.string().min(1).max(10), quantity: z.number().int().min(1).max(4) }),
      },
      ({ params, body }, _req, res) => {
        res.json({ id: params.id, ...body });
      },
    ),
  );
  app.get("/boom", () => {
    throw new Error("secret database password is hunter2");
  });
  app.get("/teapot", () => {
    throw createAppError(418, "TEAPOT", "I am a teapot.", { details: { brew: false } });
  });
  app.get("/log-inside", async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 5)); // the id must survive an await
    logger.info("inside the handler");
    res.json({});
  });
  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return { app, lines };
}

describe("request id", () => {
  it("keeps a sane id sent by nginx and returns it", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/teapot").set("X-Request-Id", "nginx-abc-123456");
    expect(res.headers["x-request-id"]).toBe("nginx-abc-123456");
  });

  it("makes a new id when none is sent, and replaces a bad one", () => {
    expect(pickRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(pickRequestId("bad id with spaces and <script>")).toMatch(/^[0-9a-f-]{36}$/);
    expect(pickRequestId("short")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is on every log line of the request, including after an await", async () => {
    const { app, lines } = buildApp();
    await request(app).get("/log-inside").set("X-Request-Id", "trace-id-987654");
    const ours = lines.filter((l) => l["requestId"] === "trace-id-987654");
    expect(ours.map((l) => l["msg"])).toEqual(expect.arrayContaining(["inside the handler", "request completed"]));
    expect(lines.every((l) => l["requestId"] === "trace-id-987654")).toBe(true);
  });
});

describe("error format", () => {
  it("answers an unknown route with 404 in the standard shape", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
    expect(typeof res.body.message).toBe("string");
  });

  it("sends status, code, message and details of an error we raised", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/teapot");
    expect(res.status).toBe(418);
    expect(res.body).toEqual({ code: "TEAPOT", message: "I am a teapot.", details: { brew: false } });
  });

  it("hides the inside of unexpected errors, but logs them", async () => {
    const { app, lines } = buildApp();
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2/);
    expect(JSON.stringify(lines)).toMatch(/hunter2/);
  });

  it("answers invalid JSON with 400, not a stack trace", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/things/1").set("Content-Type", "application/json").send("{ not json");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.message).toMatch(/not valid JSON/);
  });

  it("answers a body over the limit with 413", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/things/1").send({ title: "x".repeat(5000), quantity: 1 });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("validated()", () => {
  it("passes parsed, typed values to the handler", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/things/7").send({ title: "Hello", quantity: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "7", title: "Hello", quantity: 3 });
  });

  it("returns readable messages per field, not raw validator text", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/things/abc").send({ title: "", quantity: 9 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details.fields).toEqual({
      id: ["Must be a positive whole number"],
      title: ["Title is required"],
      quantity: ["Quantity must be at most 4"],
    });
  });

  it("says a missing field is required", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/things/1").send({ quantity: 2 });
    expect(res.body.details.fields).toEqual({ title: ["Title is required"] });
  });

  it("says a missing body is required", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/things/1");
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.details.fields)).not.toMatch(/Invalid input|expected/);
  });
});
