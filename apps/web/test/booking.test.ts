import { describe, expect, it } from "vitest";
import { reconnectDelayMs } from "@/features/availability";
import { bookingFailureMessage, createBookingIntent, isUncertain } from "@/features/booking";

describe("booking intent (the idempotency key)", () => {
  it("gives the same key for every request of one attempt: a double click is one booking", () => {
    let made = 0;
    const intent = createBookingIntent(() => `key-${(made += 1)}`);
    expect(intent.key()).toBe("key-1");
    expect(intent.key()).toBe("key-1");
    expect(intent.key()).toBe("key-1");
    expect(made).toBe(1);
  });

  it("a finished attempt is followed by a new key", () => {
    let made = 0;
    const intent = createBookingIntent(() => `key-${(made += 1)}`);
    const first = intent.key();
    intent.finish();
    const second = intent.key();
    expect(second).not.toBe(first);
    expect(intent.key()).toBe(second);
  });

  it("finishing before any key was made changes nothing", () => {
    let made = 0;
    const intent = createBookingIntent(() => `key-${(made += 1)}`);
    intent.finish();
    expect(intent.key()).toBe("key-1");
  });

  it("makes real random keys that the api accepts", () => {
    const keys = new Set(Array.from({ length: 100 }, () => createBookingIntent().key()));
    expect(keys.size).toBe(100);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
  });
});

describe("what the visitor is told when booking fails", () => {
  const failed = (status: number, code: string, details?: Record<string, unknown>) => ({
    status,
    error: { code, message: "api text", details },
    message: "fallback text",
  });

  it("sold out", () => {
    expect(bookingFailureMessage(failed(409, "SOLD_OUT", { available: 0 }))).toMatch(/sold out/i);
  });

  it("only some seats are left, with the right grammar", () => {
    expect(bookingFailureMessage(failed(409, "SOLD_OUT", { available: 1 }))).toMatch(/only 1 seat is left/i);
    expect(bookingFailureMessage(failed(409, "SOLD_OUT", { available: 3 }))).toMatch(/only 3 seats are left/i);
  });

  it("sold out without a number still says something useful", () => {
    expect(bookingFailureMessage(failed(409, "SOLD_OUT"))).toMatch(/not enough seats/i);
  });

  it("not logged in, missing event, bad quantity", () => {
    expect(bookingFailureMessage(failed(401, "UNAUTHENTICATED"))).toMatch(/log in/i);
    expect(bookingFailureMessage(failed(404, "NOT_FOUND"))).toMatch(/no longer exists/i);
    expect(bookingFailureMessage(failed(400, "VALIDATION_ERROR", { fields: { quantity: ["Quantity must be at most 4"] } }))).toBe("Quantity must be at most 4");
    expect(bookingFailureMessage(failed(400, "VALIDATION_ERROR"))).toMatch(/check the number of tickets/i);
  });

  it("anything else uses the ready-made text, never a raw error", () => {
    expect(bookingFailureMessage(failed(429, "RATE_LIMITED"))).toBe("fallback text");
    expect(bookingFailureMessage(failed(500, "INTERNAL_ERROR"))).toBe("fallback text");
  });

  it("knows when it cannot tell whether the booking happened", () => {
    expect(isUncertain(0)).toBe(true);
    expect(isUncertain(500)).toBe(true);
    expect(isUncertain(503)).toBe(true);
    expect(isUncertain(409)).toBe(false);
    expect(isUncertain(400)).toBe(false);
    expect(isUncertain(429)).toBe(false);
  });
});

describe("reconnecting to the live seats", () => {
  const noJitter = () => 1; // always the longest of the possible waits

  it("waits longer after each failure", () => {
    const waits = [0, 1, 2, 3, 4].map((attempt) => reconnectDelayMs(attempt, noJitter));
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000]);
  });

  it("never waits more than 30 seconds, however many failures", () => {
    expect(reconnectDelayMs(5, noJitter)).toBe(30_000);
    expect(reconnectDelayMs(50, noJitter)).toBe(30_000);
    expect(reconnectDelayMs(10_000, noJitter)).toBe(30_000);
  });

  it("spreads the waits out: between half and all of the base", () => {
    expect(reconnectDelayMs(3, () => 0)).toBe(4000);
    expect(reconnectDelayMs(3, () => 0.5)).toBe(6000);
    expect(reconnectDelayMs(3, () => 1)).toBe(8000);
  });

  it("a negative attempt counts as the first", () => {
    expect(reconnectDelayMs(-3, noJitter)).toBe(1000);
  });
});
