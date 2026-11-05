import { issuesToFieldErrors } from "@app/shared";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.url({
    error:
      "must be a connection URL like postgres://user:password@host:5432/db",
  }),
  REDIS_URL: z.url({
    error: "must be a connection URL like redis://:password@host:6379",
  }),
  INTERNAL_API_SECRET: z.string().min(32, { error: "must be at least 32 characters (try: openssl rand -hex 32)" }),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
  CACHE_L1_MAX_ENTRIES: z.coerce.number().int().min(1).default(1000),
  CACHE_L1_TTL_MS: z.coerce.number().int().min(0).default(10_000),
  CACHE_L2_TTL_MS: z.coerce.number().int().min(0).default(60_000),
  CACHE_NEGATIVE_TTL_MS: z.coerce.number().int().min(0).default(15_000),
  AVAILABILITY_TTL_MS: z.coerce.number().int().min(0).max(1000).default(1000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
  LOGIN_LIMIT_PER_IP: z.coerce.number().int().min(1).default(20),
  LOGIN_LIMIT_PER_EMAIL: z.coerce.number().int().min(1).default(5),
  LOGIN_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),
  SSE_HEARTBEAT_MS: z.coerce.number().int().min(100).default(15_000),
  BOOKING_HOLD_SECONDS: z.coerce.number().int().min(1).default(600),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).default(604_800),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type Env = z.infer<typeof envSchema>;

export type EnvResult =
  | { ok: true; env: Env }
  | { ok: false; problems: string[] };

/** Checks a set of variables. Pure, so it can be tested without touching the process. */
export function parseEnv(source: NodeJS.ProcessEnv): EnvResult {
  const result = envSchema.safeParse(source);
  if (result.success) return { ok: true, env: result.data };

  const fields = issuesToFieldErrors(result.error.issues);
  const problems = Object.entries(fields).flatMap(([name, messages]) =>
    messages.map((message) =>
      message.includes(name) ? message : `${name} ${message}`,
    ),
  );
  return { ok: false, problems };
}

/** Reads `process.env`. If anything is missing or wrong, says what and stops the process. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = parseEnv(source);
  if (result.ok) return result.env;

  console.error(
    [
      "api cannot start: invalid configuration",
      ...result.problems.map((p) => `  - ${p}`),
      "Check your .env file (see .env.example).",
    ].join("\n"),
  );
  process.exit(1);
}
