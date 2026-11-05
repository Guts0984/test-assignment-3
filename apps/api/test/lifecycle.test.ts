import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import { createLifecycle } from "../src/infra/lifecycle";
import { createLogger } from "../src/infra/logger";
import { createConnectionClose } from "../src/middleware/connection-close";

const logger = createLogger("silent");

function get(port: number, path: string): Promise<{ status: number; connection?: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ port, path, host: "127.0.0.1", agent: false }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, connection: res.headers.connection }));
      })
      .on("error", reject);
  });
}

function start(lifecycle: ReturnType<typeof createLifecycle>, order: string[] = []) {
  const app = express();
  app.use(createConnectionClose(lifecycle.isShuttingDown));
  app.get("/slow", (_req, res) => {
    res.on("finish", () => order.push("response sent"));
    setTimeout(() => res.json({ done: true }), 400);
  });
  const server = app.listen(0);
  return { server, port: (server.address() as AddressInfo).port };
}

describe("graceful shutdown", () => {
  it("lets a running request finish, refuses new ones, then closes resources", async () => {
    const lifecycle = createLifecycle({ logger, timeoutMs: 5000 });
    const order: string[] = [];
    const { server, port } = start(lifecycle, order);
    lifecycle.onShutdown(() => {
      order.push("hook");
    });

    const inFlight = get(port, "/slow");
    await new Promise((resolve) => setTimeout(resolve, 100)); // the request is now being handled

    const shutdown = lifecycle.shutdown(server, () => {
      order.push("resources closed");
    });
    expect(lifecycle.isShuttingDown()).toBe(true);

    // New connections are refused as soon as shutdown starts.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(get(port, "/slow")).rejects.toMatchObject({ code: "ECONNREFUSED" });

    // The request that was already running still gets its answer, and the connection is closed after it.
    const finished = await inFlight;
    expect(finished.status).toBe(200);
    expect(finished.connection).toBe("close");

    await shutdown;
    expect(order).toEqual(["hook", "response sent", "resources closed"]);
    expect(server.listening).toBe(false);
  });

  it("gives up waiting after the timeout and closes the remaining connections", async () => {
    const lifecycle = createLifecycle({ logger, timeoutMs: 200 });
    const { server, port } = start(lifecycle);

    const stuck = get(port, "/slow").catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const startedAt = Date.now();
    await lifecycle.shutdown(server, () => undefined);
    expect(Date.now() - startedAt).toBeLessThan(400); // did not wait the full 400 ms of the slow request
    await stuck;
    expect(server.listening).toBe(false);
  });

  it("does not wait for the keep-alive timeout of connections that become idle during shutdown", async () => {
    const lifecycle = createLifecycle({ logger, timeoutMs: 8000 });
    const { server, port } = start(lifecycle);
    // A client that keeps its connection open for reuse, like nginx does towards the api.
    const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 60_000 });
    const slow = new Promise<number>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/slow", agent }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        })
        .on("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const started = Date.now();
    await lifecycle.shutdown(server, () => undefined);
    const took = Date.now() - started;
    agent.destroy();

    expect(await slow).toBe(200); // the request still got its answer
    expect(took).toBeLessThan(1500); // the server's own keep-alive timeout is 5 seconds
  });

  it("runs only once if asked twice", async () => {
    const lifecycle = createLifecycle({ logger, timeoutMs: 1000 });
    const { server } = start(lifecycle);
    let closed = 0;
    const close = () => {
      closed += 1;
    };
    await Promise.all([lifecycle.shutdown(server, close), lifecycle.shutdown(server, close)]);
    expect(closed).toBe(1);
  });
});
