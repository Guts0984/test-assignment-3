import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/infra/config/env";

const valid = {
  DATABASE_URL: "postgres://user:pw@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  INTERNAL_API_SECRET: "a".repeat(32),
};

describe("parseEnv", () => {
  it("accepts the required values and fills in tuning defaults", () => {
    const result = parseEnv(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.API_PORT).toBe(4000);
      expect(result.env.LOG_LEVEL).toBe("info");
    }
  });

  it("refuses to start without the database address and says which variable is missing", () => {
    const result = parseEnv({ REDIS_URL: valid.REDIS_URL });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join("\n")).toMatch(/DATABASE_URL/);
  });

  it("refuses to start without the Redis address", () => {
    const result = parseEnv({ DATABASE_URL: valid.DATABASE_URL });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join("\n")).toMatch(/REDIS_URL/);
  });

  it("lists every problem at once", () => {
    const result = parseEnv({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toHaveLength(3);
  });

  it("rejects a malformed value instead of ignoring it", () => {
    const result = parseEnv({ ...valid, API_PORT: "not-a-port" });
    expect(result.ok).toBe(false);
  });
});
