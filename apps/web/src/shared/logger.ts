import "server-only";
import pino from "pino";

/** JSON lines on standard output, like the other programs. Callers add the request id to each line. */
export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: { service: "web" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
});
