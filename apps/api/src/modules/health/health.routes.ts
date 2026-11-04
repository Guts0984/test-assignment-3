import { Router } from "express";
import type { HealthController } from "./health.controller";

export function createHealthRouter(controller: HealthController): Router {
  const router = Router();
  router.get("/health", controller.live);
  router.get("/ready", controller.ready);
  return router;
}
