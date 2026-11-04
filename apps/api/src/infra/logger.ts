import pino, { type DestinationStream, type Logger } from "pino";
import { getRequestId } from "./request-context";

export type { Logger };

export function createLogger(
  level: string,
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level,
      base: { service: "api" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      mixin: () => {
        const requestId = getRequestId();
        return requestId ? { requestId } : {};
      },
    },
    destination,
  );
}
