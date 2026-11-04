import type { Server } from "node:http";
import type { Logger } from "./logger";

type Hook = () => Promise<void> | void;

export interface Lifecycle {
  isShuttingDown: () => boolean;
  /** Registers work to do when shutdown starts, e.g. ending SSE streams. */
  onShutdown: (hook: Hook) => void;
  /** Stops accepting connections, lets running requests finish, then runs `closeResources`. */
  shutdown: (server: Server, closeResources: Hook) => Promise<void>;
}

export interface LifecycleOptions {
  logger: Logger;
  timeoutMs: number;
}

export function createLifecycle({ logger, timeoutMs }: LifecycleOptions): Lifecycle {
  let shuttingDown = false;
  let pending: Promise<void> | undefined;
  const hooks: Hook[] = [];

  async function run(server: Server, closeResources: Hook): Promise<void> {
    logger.info("shutdown started");

    // Stop listening: no new connections. `close` calls back once the last request is done.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();

    await Promise.all(hooks.map(async (hook) => hook()));

    const timer = setTimeout(() => {
      logger.warn({ timeoutMs }, "requests did not finish in time, closing the rest");
      server.closeAllConnections();
    }, timeoutMs);

    await closed;
    clearTimeout(timer);

    await closeResources();
    logger.info("shutdown finished");
  }

  return {
    isShuttingDown: () => shuttingDown,
    onShutdown: (hook) => {
      hooks.push(hook);
    },
    shutdown: (server, closeResources) => {
      shuttingDown = true;
      pending ??= run(server, closeResources);
      return pending;
    },
  };
}
