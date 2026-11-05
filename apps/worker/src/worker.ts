import type { Database } from "@app/db";
import { OUTBOX_WAKE_CHANNEL } from "@app/shared";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { Redis } from "ioredis";
import { cleanOldRecords } from "./jobs/cleanup";
import { expireDueBookings } from "./jobs/expire-bookings";
import { enqueuePendingRevalidations } from "./jobs/outbox";
import { isAlreadyDispatched, markDispatched, sendRevalidation, type RevalidateJobData } from "./jobs/revalidate";
import type { Logger } from "./logger";

export interface WorkerSettings {
  expiryIntervalMs: number;
  outboxPollMs: number;
  revalidate: { url: string; secret: string; attempts: number; backoffMs: number; timeoutMs: number };
  /** Redis key prefix of the queues. Tests use their own so they never see each other's jobs. */
  queuePrefix?: string;
  fetchImpl?: typeof fetch;
}

export interface WorkerDeps {
  db: Database;
  /** Used to announce free seats. */
  redis: Pick<Redis, "publish">;
  /** A connection of its own, for listening to "look at the outbox now". */
  subscriber: Pick<Redis, "subscribe" | "unsubscribe" | "on" | "disconnect">;
  redisUrl: string;
  logger: Logger;
  settings: WorkerSettings;
}

export interface RunningWorker {
  /** Looks at the outbox right now instead of waiting for the next poll. Resolves when that is done. */
  pollOutbox: () => Promise<void>;
  /** Stops taking new work, lets the job in progress finish, and closes everything. */
  stop: () => Promise<void>;
}

/** `redis://:password@host:6379/0` -> the options BullMQ wants. */
export function connectionFromUrl(url: string): ConnectionOptions {
  const parsed = new URL(url);
  const db = Number(parsed.pathname.slice(1));
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(Number.isInteger(db) && db > 0 ? { db } : {}),
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function startWorker({ db, redis, subscriber, redisUrl, logger, settings }: WorkerDeps): Promise<RunningWorker> {
  const connection = connectionFromUrl(redisUrl);
  const prefix = settings.queuePrefix ?? "bull";
  const { revalidate } = settings;

  const maintenanceQueue = new Queue("maintenance", { connection, prefix });
  const revalidateQueue = new Queue<RevalidateJobData>("revalidate", { connection, prefix });

  // Repeating jobs. The scheduler makes one job per tick no matter how many workers run, so two
  // workers never expire the same bookings twice.
  await maintenanceQueue.upsertJobScheduler(
    "expire-bookings",
    { every: settings.expiryIntervalMs },
    { name: "expire-bookings", opts: { removeOnComplete: true, removeOnFail: 20 } },
  );
  await maintenanceQueue.upsertJobScheduler(
    "cleanup",
    { every: 10 * 60 * 1000 },
    { name: "cleanup", opts: { removeOnComplete: true, removeOnFail: 20 } },
  );

  const maintenanceWorker = new Worker(
    "maintenance",
    async (job) => {
      if (job.name === "expire-bookings") await expireDueBookings(db, redis, logger);
      if (job.name === "cleanup") logger.info(await cleanOldRecords(db), "cleaned old records");
    },
    { connection, prefix, concurrency: 1 },
  );

  const revalidateWorker = new Worker<RevalidateJobData>(
    "revalidate",
    async (job) => {
      const log = logger.child({ requestId: job.data.requestId, eventId: job.data.eventId, version: job.data.version });
      // The same note can reach the queue twice (two workers looking at the outbox at nearly the same moment).
      // The second job finds it already done and does nothing.
      if (await isAlreadyDispatched(db, job.data.eventId, job.data.version)) {
        log.debug("already done, skipping");
        return;
      }
      await sendRevalidation(
        { url: revalidate.url, secret: revalidate.secret, timeoutMs: revalidate.timeoutMs, ...(settings.fetchImpl ? { fetchImpl: settings.fetchImpl } : {}) },
        job.data,
      );
      await markDispatched(db, job.data.eventId, job.data.version);
      log.info({ attempt: job.attemptsMade + 1 }, "web app told about the change");
    },
    { connection, prefix, concurrency: 5 },
  );
  revalidateWorker.on("failed", (job, error) => {
    logger.warn(
      { requestId: job?.data.requestId, eventId: job?.data.eventId, attempt: job?.attemptsMade, err: error.message },
      "could not tell the web app, will try again",
    );
  });
  for (const worker of [maintenanceWorker, revalidateWorker]) {
    worker.on("error", (error) => logger.error({ err: error.message }, "queue error"));
  }

  // Looking at the outbox: now and then, and at once when the api says an event was edited.
  let stopping = false;
  let running: Promise<void> | undefined;
  let again = false;
  const pollOutbox = (): Promise<void> => {
    if (running) {
      again = true; // something changed while we were looking: look once more afterwards
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await enqueuePendingRevalidations(db, revalidateQueue, { attempts: revalidate.attempts, backoffMs: revalidate.backoffMs });
        } catch (error) {
          logger.error({ err: errorText(error) }, "could not read the outbox");
        }
      } while (again && !stopping);
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
  const timer = setInterval(() => void pollOutbox(), settings.outboxPollMs);
  subscriber.on("message", (channel: string) => {
    if (channel === OUTBOX_WAKE_CHANNEL) void pollOutbox();
  });
  await subscriber.subscribe(OUTBOX_WAKE_CHANNEL);
  void pollOutbox(); // anything left from before this worker started

  return {
    pollOutbox,
    stop: async () => {
      stopping = true;
      clearInterval(timer);
      await subscriber.unsubscribe(OUTBOX_WAKE_CHANNEL).catch(() => undefined);
      subscriber.disconnect();
      await running;
      // close() waits for the job in progress to finish; nothing is cut off halfway.
      await Promise.all([maintenanceWorker.close(), revalidateWorker.close()]);
      await Promise.all([maintenanceQueue.close(), revalidateQueue.close()]);
    },
  };
}
