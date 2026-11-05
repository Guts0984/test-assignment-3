import { describe, expect, it } from "vitest";
import { filtersToQueryString, parseFilters, sameFilters } from "@/features/catalog";
import { safeNextPath } from "@/features/auth";
import { formatRemaining, remainingMs, serverNowFromBrowser } from "@/features/checkout";

describe("catalog filters in the address bar", () => {
  it("reads what is there", () => {
    expect(parseFilters({ city: "Paris", q: "jazz", from: "2026-12-01", to: "2026-12-31" })).toEqual({ city: "Paris", q: "jazz", from: "2026-12-01", to: "2026-12-31" });
  });

  it("trims, ignores blanks, takes the first of a repeated parameter", () => {
    expect(parseFilters({ city: "  Berlin  ", q: "   ", from: ["2026-01-01", "2026-02-02"] })).toEqual({ city: "Berlin", q: undefined, from: "2026-01-01", to: undefined });
  });

  it("ignores dates that are not dates, so a hand-edited address cannot break the page", () => {
    expect(parseFilters({ from: "yesterday", to: "2026-13-45" })).toEqual({ city: undefined, q: undefined, from: undefined, to: undefined });
    expect(parseFilters({ from: "2026-02-30" }).from).toBeUndefined();
  });

  it("cuts very long text", () => {
    expect(parseFilters({ q: "x".repeat(500) }).q).toHaveLength(100);
  });

  it("writes only the filters that are set, in a fixed order", () => {
    expect(filtersToQueryString({ q: "jazz", city: "Paris" })).toBe("?city=Paris&q=jazz");
    expect(filtersToQueryString({})).toBe("");
    expect(filtersToQueryString({ city: "", q: "  " })).toBe("");
  });

  it("escapes what needs escaping", () => {
    expect(filtersToQueryString({ q: "rock & roll" })).toBe("?q=rock+%26+roll");
    expect(parseFilters({ q: "rock & roll" }).q).toBe("rock & roll");
  });

  it("recognises filters that are the same", () => {
    expect(sameFilters({ city: "Paris", q: "" }, { city: "Paris" })).toBe(true);
    expect(sameFilters({ city: "Paris" }, { city: "Rome" })).toBe(false);
    expect(sameFilters({ q: " jazz " }, { q: "jazz" })).toBe(true);
  });

  it("what is written can be read back unchanged", () => {
    const filters = { city: "Paris", q: "late night", from: "2026-12-01", to: "2026-12-31" };
    const params = Object.fromEntries(new URLSearchParams(filtersToQueryString(filters)));
    expect(parseFilters(params)).toEqual(filters);
  });
});

describe("where to go after logging in", () => {
  it("accepts paths on this site", () => {
    expect(safeNextPath("/me/bookings")).toBe("/me/bookings");
    expect(safeNextPath("/events/5?x=1")).toBe("/events/5?x=1");
  });

  it.each([
    ["another site", "https://evil.example/"],
    ["a protocol-relative address", "//evil.example"],
    ["a backslash trick", "/\\evil.example"],
    ["a script", "javascript:alert(1)"],
    ["no leading slash", "events/5"],
    ["a header injection", "/ok\r\nSet-Cookie: x=1"],
    ["empty", ""],
  ])("goes home instead of %s", (_name, raw) => {
    expect(safeNextPath(raw)).toBe("/");
  });

  it("goes home when there is nothing", () => {
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath(null)).toBe("/");
  });
});

describe("the checkout countdown", () => {
  it("counts down to zero and no further", () => {
    expect(remainingMs(10_000, 4_000)).toBe(6000);
    expect(remainingMs(10_000, 10_000)).toBe(0);
    expect(remainingMs(10_000, 99_000)).toBe(0);
  });

  it("shows minutes and seconds, rounding up so 0:00 means really over", () => {
    expect(formatRemaining(600_000)).toBe("10:00");
    expect(formatRemaining(583_000)).toBe("9:43");
    expect(formatRemaining(59_001)).toBe("1:00");
    expect(formatRemaining(1)).toBe("0:01");
    expect(formatRemaining(0)).toBe("0:00");
    expect(formatRemaining(61_000)).toBe("1:01");
    expect(formatRemaining(5_000)).toBe("0:05");
  });

  it("follows the server's clock even when the browser's clock is wrong", () => {
    // The server says it is 12:00:00; this browser thinks it is 11:50:00 (10 minutes slow).
    const serverNow = Date.parse("2026-12-01T12:00:00Z");
    const browserAtLoad = Date.parse("2026-12-01T11:50:00Z");
    const offset = serverNow - browserAtLoad;
    const expiresAt = Date.parse("2026-12-01T12:10:00Z");
    // Ten browser-seconds after loading:
    const browserLater = browserAtLoad + 10_000;
    expect(remainingMs(expiresAt, serverNowFromBrowser(browserLater, offset))).toBe(590_000);
    // Without the correction the page would claim 20 minutes were left.
    expect(remainingMs(expiresAt, browserLater)).toBe(1_190_000);
  });
});
