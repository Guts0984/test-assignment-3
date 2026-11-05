import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "@/shared/lib/debounce";
import { createLatestOnly } from "@/shared/lib/latest-only";

describe("debounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for a pause, then runs once with the last value", () => {
    const run = vi.fn();
    const search = debounce(run, 300);
    search("j");
    search("ja");
    search("jaz");
    search("jazz");
    vi.advanceTimersByTime(299);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("jazz");
  });

  it("every new call restarts the wait", () => {
    const run = vi.fn();
    const search = debounce(run, 300);
    search("a");
    vi.advanceTimersByTime(250);
    search("ab");
    vi.advanceTimersByTime(250);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(run).toHaveBeenCalledWith("ab");
  });

  it("runs again for a later burst", () => {
    const run = vi.fn();
    const search = debounce(run, 100);
    search("one");
    vi.advanceTimersByTime(100);
    search("two");
    vi.advanceTimersByTime(100);
    expect(run.mock.calls).toEqual([["one"], ["two"]]);
  });

  it("cancel drops the waiting call, and cancelling with nothing waiting is harmless", () => {
    const run = vi.fn();
    const search = debounce(run, 100);
    search.cancel();
    search("x");
    search.cancel();
    vi.advanceTimersByTime(500);
    expect(run).not.toHaveBeenCalled();
    search("y");
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledWith("y");
  });
});

describe("answers that arrive in the wrong order", () => {
  it("only the most recent request is current", () => {
    const latest = createLatestOnly();
    const first = latest.next();
    const second = latest.next();
    expect(latest.isCurrent(first)).toBe(false);
    expect(latest.isCurrent(second)).toBe(true);
  });

  it("a slow old answer cannot overwrite a newer one (simulated search)", async () => {
    const latest = createLatestOnly();
    let shown = "";
    const search = async (term: string, delayMs: number) => {
      const ticket = latest.next();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (latest.isCurrent(ticket)) shown = term; // what the real code does before using an answer
    };
    await Promise.all([search("old", 50), search("new", 5)]); // the old one answers last
    expect(shown).toBe("new");
  });

  it("invalidate makes everything started so far out of date", () => {
    const latest = createLatestOnly();
    const ticket = latest.next();
    latest.invalidate();
    expect(latest.isCurrent(ticket)).toBe(false);
    expect(latest.isCurrent(latest.next())).toBe(true);
  });
});
