// Runs once when the server starts. If the settings are wrong, the server stops here with a clear message.
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  const { parseWebEnv } = await import("@/shared/config/env");
  const result = parseWebEnv(process.env);
  if (!result.ok) {
    // Stops the server from starting, and the message says what to fix.
    throw new Error(["web cannot start: invalid configuration", ...result.problems.map((p) => `  - ${p}`), "Check your .env file (see .env.example)."].join("\n"));
  }
}
