import { Redis } from "ioredis";
import type { Logger } from "./logger";

export type { Redis };

export function createRedis(url: string, logger: Logger) {
  const redis = new Redis(url, { maxRetriesPerRequest: 2 });
  redis.on("error", (error: Error) => {
    logger.error({ err: error.message }, "redis connection error");
  });
  return { redis, close: async () => void (await redis.quit().catch(() => redis.disconnect())) };
}
