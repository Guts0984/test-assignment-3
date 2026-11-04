import type { DbPool } from "@app/db";
import type { Redis } from "../../infra/redis";
import { withTimeout } from "../../lib/async";

export type CheckStatus = "up" | "down";

export interface ReadinessReport {
  ready: boolean;
  checks: { database: CheckStatus; redis: CheckStatus };
}

export interface HealthService {
  checkReadiness: () => Promise<ReadinessReport>;
}

export interface HealthServiceDeps {
  pool: Pick<DbPool, "query">;
  redis: Pick<Redis, "ping">;
  timeoutMs?: number;
}

async function probe(check: () => Promise<unknown>, ms: number, what: string): Promise<CheckStatus> {
  try {
    await withTimeout(check(), ms, what);
    return "up";
  } catch {
    return "down";
  }
}

export function createHealthService({ pool, redis, timeoutMs = 2000 }: HealthServiceDeps): HealthService {
  return {
    async checkReadiness() {
      const [database, redisStatus] = await Promise.all([
        probe(() => pool.query("SELECT 1"), timeoutMs, "database check"),
        probe(() => redis.ping(), timeoutMs, "redis check"),
      ]);
      return {
        ready: database === "up" && redisStatus === "up",
        checks: { database, redis: redisStatus },
      };
    },
  };
}
