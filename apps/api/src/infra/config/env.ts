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
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
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
