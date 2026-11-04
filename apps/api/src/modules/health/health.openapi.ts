import { z } from "zod";
import { errorResponse, type RouteDoc } from "../../infra/openapi/build-document";

const checkStatus = z.enum(["up", "down"]);

export const healthRoutes: RouteDoc[] = [
  {
    method: "get",
    path: "/health",
    summary: "Liveness: the process is running",
    tags: ["Health"],
    responses: { 200: { description: "Alive", schema: z.object({ status: z.literal("ok") }) } },
  },
  {
    method: "get",
    path: "/ready",
    summary: "Readiness: PostgreSQL and Redis are reachable",
    tags: ["Health"],
    responses: {
      200: {
        description: "Ready",
        schema: z.object({
          status: z.literal("ready"),
          checks: z.object({ database: checkStatus, redis: checkStatus }),
        }),
      },
      503: errorResponse("A dependency is down, or the server is shutting down"),
    },
  },
];
