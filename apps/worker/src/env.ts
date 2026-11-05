import { issuesToFieldErrors } from "@app/shared";
import { z } from "zod";

/** Required (no default): where things are, and the secret shared with api and web. */
const envSchema = z.object({
  DATABASE_URL: z.url({ error: "must be a connection URL like postgres://user:password@host:5432/db" }),
  REDIS_URL: z.url({ error: "must be a connection URL like redis://:password@host:6379" }),
  INTERNAL_API_SECRET: z.string().min(32, { error: "must be at least 32 characters (try: openssl rand -hex 32)" }),
  WEB_REVALIDATE_URL: z.url({ error: "must be the address of the web app's refresh endpoint" }),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(5),
  EXPIRY_INTERVAL_MS: z.coerce.number().int().min(50).default(2_000),
  OUTBOX_POLL_MS: z.coerce.number().int().min(20).default(500),
  REVALIDATE_ATTEMPTS: z.coerce.number().int().min(1).default(12),
  REVALIDATE_BACKOFF_MS: z.coerce.number().int().min(1).default(1_000),
  REVALIDATE_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
});

export type Env = z.infer<typeof envSchema>;
export type EnvResult = { ok: true; env: Env } | { ok: false; problems: string[] };

export function parseEnv(source: NodeJS.ProcessEnv): EnvResult {
  const result = envSchema.safeParse(source);
  if (result.success) return { ok: true, env: result.data };
  const fields = issuesToFieldErrors(result.error.issues);
  const problems = Object.entries(fields).flatMap(([name, messages]) =>
    messages.map((message) => (message.includes(name) ? message : `${name} ${message}`)),
  );
  return { ok: false, problems };
}

/** Reads `process.env`. If anything is missing or wrong, says what and stops the process. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = parseEnv(source);
  if (result.ok) return result.env;
  console.error(
    ["worker cannot start: invalid configuration", ...result.problems.map((p) => `  - ${p}`), "Check your .env file (see .env.example)."].join("\n"),
  );
  process.exit(1);
}
