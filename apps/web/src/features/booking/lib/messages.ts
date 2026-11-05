import type { ApiError } from "@app/shared";

export interface FailedCall {
  status: number;
  error: ApiError;
  message: string;
}

/** What to tell the visitor when booking did not work. Always a sentence a person can act on. */
export function bookingFailureMessage({ status, error, message }: FailedCall): string {
  if (status === 409 && error.code === "SOLD_OUT") {
    const available = error.details?.["available"];
    if (available === 0) return "Sorry, the last seats were just taken. This event is sold out.";
    if (typeof available === "number") {
      return `Not enough seats: only ${available} ${available === 1 ? "seat is" : "seats are"} left. Choose fewer tickets and try again.`;
    }
    return "Not enough seats are left for that many tickets.";
  }
  if (status === 401) return "Please log in to book seats.";
  if (status === 404) return "This event no longer exists.";
  if (status === 400) {
    const first = Object.values(error.details?.["fields"] ?? {}).flat()[0];
    return typeof first === "string" ? first : "Please check the number of tickets and try again.";
  }
  return message;
}

/** A failure that does not tell us whether the booking happened (no answer at all, or a server error). */
export const isUncertain = (status: number): boolean => status === 0 || status >= 500;
