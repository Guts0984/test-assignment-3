import type { Database, DbPool } from "@app/db";
import type { EventDto } from "@app/shared";
import express, { type Express } from "express";
import swaggerUi from "swagger-ui-express";
import type { Cache, Generation } from "./infra/cache/two-level-cache";
import type { Lifecycle } from "./infra/lifecycle";
import { createRateLimiter, type LimitRule } from "./infra/rate-limiter";
import type { SeatsHub } from "./infra/seats-hub";
import type { SeatsNotifier } from "./infra/seats-notifier";
import type { Logger } from "./infra/logger";
import { buildOpenApiDocument, type RouteDoc } from "./infra/openapi/build-document";
import type { Redis } from "./infra/redis";
import { createAccessLog } from "./middleware/access-log";
import { createSessionLoader } from "./middleware/auth";
import { createClientIdentity } from "./middleware/client-ip";
import { createRateLimit } from "./middleware/rate-limit";
import { createConnectionClose } from "./middleware/connection-close";
import { createErrorHandler } from "./middleware/error-handler";
import { notFoundHandler } from "./middleware/not-found";
import { requestId } from "./middleware/request-id";
import { createAuthController } from "./modules/auth/auth.controller";
import { authRoutes, createAuthRouter } from "./modules/auth/auth.routes";
import { createAuthService } from "./modules/auth/auth.service";
import { createLoginGuard } from "./modules/auth/login-guard";
import { createPasswordHasher } from "./modules/auth/password-hasher";
import { createSessionStore } from "./modules/auth/session-store";
import { createUsersRepository } from "./modules/auth/users.repository";
import { createBookingsController } from "./modules/bookings/bookings.controller";
import { createBookingsRepository } from "./modules/bookings/bookings.repository";
import { bookingsRoutes, createBookingsRouter } from "./modules/bookings/bookings.routes";
import { createBookingsService } from "./modules/bookings/bookings.service";
import { createEventsController } from "./modules/events/events.controller";
import { createEventsRepository } from "./modules/events/events.repository";
import { createEventsRouter, eventsRoutes } from "./modules/events/events.routes";
import { createEventsService, type CacheTimings } from "./modules/events/events.service";
import { createHealthController } from "./modules/health/health.controller";
import { healthRoutes } from "./modules/health/health.openapi";
import { createHealthRouter } from "./modules/health/health.routes";
import { createHealthService } from "./modules/health/health.service";

export interface AppConfig {
  sessionTtlSeconds: number;
  cookieSecure: boolean;
  cache: CacheTimings;
  /** How long a booking holds its seats before it must be confirmed. */
  bookingHoldSeconds: number;
  /** Secret shared with our own web server and worker, to recognise their calls. */
  internalSecret: string;
  /** How often the live seat stream sends a keep-alive line. */
  sseHeartbeatMs: number;
  rateLimit: { general: LimitRule; loginPerIp: LimitRule; loginPerEmail: LimitRule };
}

export interface AppDeps {
  logger: Logger;
  db: Database;
  pool: Pick<DbPool, "query">;
  redis: Redis;
  lifecycle: Pick<Lifecycle, "isShuttingDown">;
  cache: Cache;
  /** Changes whenever any event changes (see two-level-cache.ts). */
  catalog: Generation;
  notifier: SeatsNotifier;
  hub: SeatsHub;
  /** Called after an event was edited (the worker/web refresh hook arrives with the worker). */
  onEventUpdated?: (event: EventDto) => Promise<void> | void;
  config: AppConfig;
}

/** Everything the api documents; each module adds its own routes here as it is built. */
const documentedRoutes: RouteDoc[] = [...healthRoutes, ...authRoutes, ...eventsRoutes, ...bookingsRoutes];

export function createApp({ logger, db, pool, redis, lifecycle, cache, catalog, notifier, hub, onEventUpdated, config }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  // nginx is the one proxy in front of us: believe the address it puts in X-Forwarded-For, nothing before it.
  app.set("trust proxy", 1);

  const limiter = createRateLimiter(redis, logger);

  app.use(requestId);
  app.use(createConnectionClose(lifecycle.isShuttingDown));
  app.use(createAccessLog(logger));
  app.use(createClientIdentity(config.internalSecret));
  app.use(createRateLimit(limiter, config.rateLimit.general));
  app.use(express.json({ limit: "100kb" }));

  const healthService = createHealthService({ pool, redis });
  app.use(createHealthRouter(createHealthController(healthService, lifecycle.isShuttingDown)));

  const auth = createAuthService({
    users: createUsersRepository(db),
    hasher: createPasswordHasher(),
    sessions: createSessionStore({ redis, ttlSeconds: config.sessionTtlSeconds }),
  });
  app.use(createSessionLoader(auth));
  const loginGuard = createLoginGuard({
    limiter,
    perIp: config.rateLimit.loginPerIp,
    perEmail: config.rateLimit.loginPerEmail,
  });
  app.use(createAuthRouter(createAuthController({ auth, cookieSecure: config.cookieSecure, loginGuard })));

  const events = createEventsService({
    repository: createEventsRepository(db),
    cache,
    catalog,
    timings: config.cache,
    notifier,
    onUpdated: onEventUpdated,
  });
  app.use(createEventsRouter(createEventsController(events, { hub, heartbeatMs: config.sseHeartbeatMs })));

  const bookings = createBookingsService({
    db,
    repository: createBookingsRepository(db),
    notifier,
    holdSeconds: config.bookingHoldSeconds,
  });
  app.use(createBookingsRouter(createBookingsController(bookings)));

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
