export const pgErrorCodes = {
  checkViolation: "23514",
  uniqueViolation: "23505",
  invalidBookingTransition: "BK001",
} as const;

export const seatsWithinCapacityConstraint =
  "events_booked_seats_within_capacity";

export interface PgErrorInfo {
  code: string;
  constraint?: string;
  message: string;
}

export function readPgError(error: unknown): PgErrorInfo | undefined {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && typeof current === "object" && current !== null;
    depth += 1
  ) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code,
        constraint:
          typeof candidate.constraint === "string"
            ? candidate.constraint
            : undefined,
        message: typeof candidate.message === "string" ? candidate.message : "",
      };
    }
    current = candidate.cause;
  }
  return undefined;
}

export function isSoldOutError(error: unknown): boolean {
  const info = readPgError(error);
  return (
    info?.code === pgErrorCodes.checkViolation &&
    info.constraint === seatsWithinCapacityConstraint
  );
}
