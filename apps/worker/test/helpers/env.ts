import { randomUUID } from "node:crypto";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { createDb, type Database } from "@app/db";
import { Redis } from "ioredis";
import pg from "pg";
import { inject } from "vitest";
import { createLogger } from "../../src/logger";
import { startWorker, type RunningWorker, type WorkerSettings } from "../../src/worker";

export const SECRET = "worker-test-secret-worker-test-secret-1";

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export interface TestWorld {
  db: Database;
  pool: ReturnType<typeof createDb>["pool"];
  redis: Redis;
  close: () => Promise<void>;
  /** Starts a worker on this database and Redis. `prefix` decides which queues it shares. */
  startWorker: (options?: StartOptions) => Promise<RunningWorker>;
}

export interface StartOptions {
  prefix?: string;
  webUrl?: string;
  expiryIntervalMs?: number;
  outboxPollMs?: number;
  attempts?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

/** A fresh, migrated, empty database and an emptied Redis. */
export async function createWorld(): Promise<TestWorld> {
  const baseUrl = inject("pgBaseUrl");
  const name = `w_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: withDatabase(baseUrl, "postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${inject("pgTemplateDb")}`);
  await admin.end();

  const database = createDb(withDatabase(baseUrl, name), { max: 10 });
  const redis = new Redis(inject("redisUrl"));
  await redis.flushall();
  const running: RunningWorker[] = [];

  return {
    db: database.db,
    pool: database.pool,
    redis,
    startWorker: async (options = {}) => {
      const settings: WorkerSettings = {
        expiryIntervalMs: options.expiryIntervalMs ?? 60_000,
        outboxPollMs: options.outboxPollMs ?? 60_000,
        queuePrefix: options.prefix ?? `t${randomUUID().slice(0, 8)}`,
        revalidate: {
          url: options.webUrl ?? "http://127.0.0.1:9/never",
          secret: SECRET,
          attempts: options.attempts ?? 5,
          backoffMs: options.backoffMs ?? 50,
          timeoutMs: options.timeoutMs ?? 1000,
        },
      };
      const worker = await startWorker({
        db: database.db,
        redis,
        subscriber: redis.duplicate(),
        redisUrl: inject("redisUrl"),
        logger: createLogger("silent"),
        settings,
      });
      running.push(worker);
      return worker;
    },
    close: async () => {
      await Promise.all(running.map((worker) => worker.stop().catch(() => undefined)));
      redis.disconnect();
      await database.close();
    },
  };
}

export interface SeenRequest {
  at: number;
  method: string;
  headers: IncomingHttpHeaders;
  body: string;
  /** What the fake answered. */
  answered: "ok" | "error" | "dropped" | "slow";
}

export type Behaviour = "ok" | "error" | "drop" | "slow";

export interface FakeWeb {
  url: string;
  port: number;
  requests: SeenRequest[];
  succeeded: () => SeenRequest[];
  /** Change how it answers from now on. */
  behave: (next: Behaviour | ((attempt: number) => Behaviour)) => void;
  stop: () => Promise<void>;
}

/** Stands in for the web app's refresh endpoint, with answers we can choose. */
export async function startFakeWeb(initial: Behaviour | ((attempt: number) => Behaviour) = "ok", port = 0): Promise<FakeWeb> {
  const requests: SeenRequest[] = [];
  let behaviour = initial;
  const sockets = new Set<import("node:net").Socket>();

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const mode = typeof behaviour === "function" ? behaviour(requests.length + 1) : behaviour;
      const seen: SeenRequest = { at: Date.now(), method: req.method ?? "", headers: req.headers, body, answered: mode === "drop" ? "dropped" : mode };
      requests.push(seen);
      if (mode === "drop") {
        req.socket.destroy();
      } else if (mode === "slow") {
        setTimeout(() => res.writeHead(200).end("{}"), 5000).unref();
      } else if (mode === "error") {
        res.writeHead(503).end("{}");
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actualPort = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${actualPort}/api/internal/revalidate`,
    port: actualPort,
    requests,
    succeeded: () => requests.filter((r) => r.answered === "ok"),
    behave: (next) => {
      behaviour = next;
    },
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `check` is true (looked at every 20 ms). */
export async function until(check: () => boolean | Promise<boolean>, ms = 5000, what = "the expected state"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
