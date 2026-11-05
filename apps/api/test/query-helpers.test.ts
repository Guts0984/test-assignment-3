import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, resolveDateRange, toTsQuery } from "../src/modules/events/query-helpers";

describe("toTsQuery", () => {
  it("matches the beginning of every word, all words required", () => {
    expect(toTsQuery("orch con")).toBe("orch:* & con:*");
    expect(toTsQuery("  Midnight   ORCHESTRA ")).toBe("midnight:* & orchestra:*");
  });

  it("keeps letters and digits of any alphabet", () => {
    expect(toTsQuery("Ёж Café 2026")).toBe("ёж:* & café:* & 2026:*");
  });

  it("removes every character that has a meaning in a Postgres text query", () => {
    for (const hostile of ["&", "|", "!", ":*", "(", ")", "'", "\\", "<->", "a:b", "x' ; DROP TABLE events; --"]) {
      const result = toTsQuery(hostile);
      if (result !== undefined) expect(result).toMatch(/^[\p{L}\p{N}]+:\*( & [\p{L}\p{N}]+:\*)*$/u);
    }
    expect(toTsQuery("x' ; DROP TABLE events; --")).toBe("x:* & drop:* & table:* & events:*");
  });

  it("gives nothing to search for when there are no words", () => {
    expect(toTsQuery("")).toBeUndefined();
    expect(toTsQuery("   ")).toBeUndefined();
    expect(toTsQuery("&|!:*()")).toBeUndefined();
  });

  it("caps the number of words, so a huge query cannot make a huge database query", () => {
    const query = toTsQuery(Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ")) ?? "";
    expect(query.split(" & ")).toHaveLength(8);
  });
});

describe("cursor", () => {
  it("survives a round trip", () => {
    const cursor = { startsAt: "2026-12-01T18:30:00.000Z", id: 42 };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ["empty", ""],
    ["random text", "hello"],
    ["valid base64 but not JSON", Buffer.from("not json").toString("base64url")],
    ["JSON of the wrong shape", Buffer.from(JSON.stringify({ a: 1 })).toString("base64url")],
    ["a negative id", Buffer.from(JSON.stringify({ t: "2026-12-01T18:30:00.000Z", i: -1 })).toString("base64url")],
    ["a fractional id", Buffer.from(JSON.stringify({ t: "2026-12-01T18:30:00.000Z", i: 1.5 })).toString("base64url")],
    ["an id given as text", Buffer.from(JSON.stringify({ t: "2026-12-01T18:30:00.000Z", i: "1; DROP" })).toString("base64url")],
    ["a time that is not a time", Buffer.from(JSON.stringify({ t: "yesterday", i: 1 })).toString("base64url")],
    ["a very long string", "A".repeat(10_000)],
  ])("rejects a cursor that is %s", (_name, text) => {
    expect(decodeCursor(text)).toBeUndefined();
  });
});

describe("resolveDateRange", () => {
  it("a plain 'from' date starts at midnight UTC", () => {
    expect(resolveDateRange("2026-12-01", undefined).from?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("a plain 'to' date includes that whole day", () => {
    const { toExclusive } = resolveDateRange(undefined, "2026-12-31");
    expect(toExclusive?.toISOString()).toBe("2027-01-01T00:00:00.000Z"); // the next midnight, not included
  });

  it("'to' with a time includes events starting at exactly that moment", () => {
    const { toExclusive } = resolveDateRange(undefined, "2026-12-31T18:00:00.000Z");
    expect(toExclusive?.getTime()).toBe(Date.parse("2026-12-31T18:00:00.000Z") + 1);
  });

  it("respects a time zone offset", () => {
    expect(resolveDateRange("2026-12-01T10:00:00+02:00", undefined).from?.toISOString()).toBe("2026-12-01T08:00:00.000Z");
  });

  it("gives no limits when nothing is given", () => {
    expect(resolveDateRange(undefined, undefined)).toEqual({});
  });
});
