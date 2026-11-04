import type { DbPool } from "@app/db";
import express, { type Express } from "express";
import swaggerUi from "swagger-ui-express";
import type { Lifecycle } from "./infra/lifecycle";
import type { Logger } from "./infra/logger";
import { buildOpenApiDocument, type RouteDoc } from "./infra/openapi/build-document";
import type { Redis } from "./infra/redis";
import { createAccessLog } from "./middleware/access-log";
import { createConnectionClose } from "./middleware/connection-close";
import { createErrorHandler } from "./middleware/error-handler";
import { notFoundHandler } from "./middleware/not-found";
import { requestId } from "./middleware/request-id";
import { createHealthController } from "./modules/health/health.controller";
import { healthRoutes } from "./modules/health/health.openapi";
import { createHealthRouter } from "./modules/health/health.routes";
import { createHealthService } from "./modules/health/health.service";

export interface AppDeps {
  logger: Logger;
  pool: Pick<DbPool, "query">;
  redis: Pick<Redis, "ping">;
  lifecycle: Pick<Lifecycle, "isShuttingDown">;
}

/** Everything the api documents; each module adds its own routes here as it is built. */
const documentedRoutes: RouteDoc[] = [...healthRoutes];

export function createApp({ logger, pool, redis, lifecycle }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use(requestId);
  app.use(createConnectionClose(lifecycle.isShuttingDown));
  app.use(createAccessLog(logger));
  app.use(express.json({ limit: "100kb" }));

  const healthService = createHealthService({ pool, redis });
  app.use(createHealthRouter(createHealthController(healthService, lifecycle.isShuttingDown)));

  const openApiDocument = buildOpenApiDocument(
    { title: "Event Tickets API", version: "1.0.0", description: "Catalog, bookings and live seat counts." },
    documentedRoutes,
  );
  app.get("/openapi.json", (_req, res) => {
    res.json(openApiDocument);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
