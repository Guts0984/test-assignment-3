import type { RequestHandler } from "express";
import { notReady } from "../../lib/app-error";
import type { HealthService } from "./health.service";

export interface HealthController {
  live: RequestHandler;
  ready: RequestHandler;
}

export function createHealthController(
  service: HealthService,
  isShuttingDown: () => boolean,
): HealthController {
  return {
    // The process is alive and answering. Says nothing about its dependencies.
    live: (_req, res) => {
      res.json({ status: "ok" });
    },

    ready: async (_req, res) => {
      if (isShuttingDown()) {
        throw notReady("The server is shutting down.", { shuttingDown: true });
      }
      const report = await service.checkReadiness();
      if (!report.ready) {
        throw notReady("A required service is not available.", { checks: report.checks });
      }
      res.json({ status: "ready", checks: report.checks });
    },
  };
}
