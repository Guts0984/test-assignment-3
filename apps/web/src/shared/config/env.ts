import "server-only";
import { issuesToFieldErrors } from "@app/shared";
import { z } from "zod";

/** Server-only settings. This file is never imported by client code (`server-only` makes the build fail if it is). */
const schema = z.object({
  /** Where the api instances are, inside the Docker network. Never sent to the browser. */
  API_URL: z.url({ error: "must be the internal address of the api, like http://api:4000" }),
  /** Shared with the api and the worker; proves a call comes from one of our own programs. */
  INTERNAL_API_SECRET: z.string().min(32, { error: "must be at least 32 characters (try: openssl rand -hex 32)" }),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type WebEnv = z.infer<typeof schema>;

type Result = { ok: true; env: WebEnv } | { ok: false; problems: string[] };

export function parseWebEnv(source: NodeJS.ProcessEnv): Result {
  const result = schema.safeParse(source);
  if (result.success) return { ok: true, env: result.data };
  const fields = issuesToFieldErrors(result.error.issues);
  const problems = Object.entries(fields).flatMap(([name, messages]) =>
    messages.map((message) => (message.includes(name) ? message : `${name} ${message}`)),
  );
  return { ok: false, problems };
}

let cached: WebEnv | undefined;

/** The checked settings. Throws a readable message if something is missing. */
export function getEnv(): WebEnv {
  if (cached) return cached;
  const result = parseWebEnv(process.env);
  if (!result.ok) {
    throw new Error(["web cannot start: invalid configuration", ...result.problems.map((p) => `  - ${p}`), "Check your .env file (see .env.example)."].join("\n"));
  }
  cached = result.env;
  return cached;
}
