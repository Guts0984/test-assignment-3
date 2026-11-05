import { describe, expect, it } from "vitest";
import { createMemoryCache } from "../src/infra/cache/memory-cache";

const clock = (start = 1_000) => {
  let time = start;
  return { now: () => time, advance: (ms: number) => void (time += ms) };
};

describe("memory cache", () => {
  it("returns what was stored, and tells 'stored null' apart from 'not stored'", () => {
    const cache = createMemoryCache<string | null>({ maxEntries: 10 });
    cache.set("a", "x", 1000);
    cache.set("gone", null, 1000);
    expect(cache.get("a")).toEqual({ value: "x" });
    expect(cache.get("gone")).toEqual({ value: null });
    expect(cache.get("never")).toBeUndefined();
  });

  it("forgets an entry exactly when its time is up", () => {
    const time = clock();
    const cache = createMemoryCache<string>({ maxEntries: 10, now: time.now });
    cache.set("a", "x", 500);
    time.advance(499);
    expect(cache.get("a")).toBeDefined();
    time.advance(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size()).toBe(0); // an expired entry is removed when it is found out
  });

  it("drops the least recently USED entry when full, not the oldest inserted", () => {
    const cache = createMemoryCache<number>({ maxEntries: 3 });
    cache.set("a", 1, 10_000);
    cache.set("b", 2, 10_000);
    cache.set("c", 3, 10_000);
    cache.get("a"); // a is now the most recently used
    cache.set("d", 4, 10_000);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.get("d")).toBeDefined();
    expect(cache.size()).toBe(3);
  });

  it("never grows past its limit, however many keys it sees", () => {
    const cache = createMemoryCache<number>({ maxEntries: 50 });
    for (let i = 0; i < 5000; i += 1) cache.set(`k${i}`, i, 10_000);
    expect(cache.size()).toBe(50);
    expect(cache.get("k4999")).toBeDefined();
    expect(cache.get("k0")).toBeUndefined();
  });

  it("writing a key again restarts its time and moves it to the front", () => {
    const time = clock();
    const cache = createMemoryCache<number>({ maxEntries: 2, now: time.now });
    cache.set("a", 1, 100);
    time.advance(90);
    cache.set("a", 2, 100);
    time.advance(90);
    expect(cache.get("a")).toEqual({ value: 2 });
    cache.set("b", 3, 100);
    cache.set("c", 4, 100); // full: the least recently used is a (read before b and c were written)
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual({ value: 3 });
    expect(cache.get("c")).toEqual({ value: 4 });
  });

  it("does not store anything with a lifetime of zero or less", () => {
    const cache = createMemoryCache<number>({ maxEntries: 5 });
    cache.set("a", 1, 0);
    cache.set("b", 2, -10);
    expect(cache.size()).toBe(0);
  });

  it("can delete one key or everything", () => {
    const cache = createMemoryCache<number>({ maxEntries: 5 });
    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("refuses a size that makes no sense", () => {
    expect(() => createMemoryCache({ maxEntries: 0 })).toThrow();
    expect(() => createMemoryCache({ maxEntries: 1.5 })).toThrow();
  });
});
