import { hash as plainArgon2 } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import { createPasswordHasher } from "../src/modules/auth/password-hasher";

const hasher = createPasswordHasher();

const timeOf = async (work: () => Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await work();
  return performance.now() - started;
};
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

describe("hash", () => {
  it("makes an argon2id hash with the intended strength", async () => {
    const stored = await hasher.hash("correct horse battery");
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it("never contains the password", async () => {
    const stored = await hasher.hash("my-very-secret-password");
    expect(stored).not.toContain("my-very-secret-password");
  });

  it("gives a different hash for the same password each time (random salt)", async () => {
    const [a, b] = await Promise.all([hasher.hash("same password"), hasher.hash("same password")]);
    expect(a).not.toBe(b);
    expect(await hasher.verify(a, "same password")).toBe(true);
    expect(await hasher.verify(b, "same password")).toBe(true);
  });
});

describe("verify", () => {
  it("accepts the right password and refuses a wrong one", async () => {
    const stored = await hasher.hash("Right-Password-1");
    expect(await hasher.verify(stored, "Right-Password-1")).toBe(true);
    expect(await hasher.verify(stored, "Right-Password-2")).toBe(false);
  });

  it("is case sensitive and sensitive to spaces at the ends", async () => {
    const stored = await hasher.hash("Secret Pass");
    expect(await hasher.verify(stored, "secret pass")).toBe(false);
    expect(await hasher.verify(stored, "Secret Pass ")).toBe(false);
    expect(await hasher.verify(stored, " Secret Pass")).toBe(false);
  });

  it("keeps spaces at the ends of the password: the user who chose them must be able to log in", async () => {
    const stored = await hasher.hash("  padded password  ");
    expect(await hasher.verify(stored, "  padded password  ")).toBe(true);
    expect(await hasher.verify(stored, "padded password")).toBe(false);
  });

  it("refuses an empty password", async () => {
    const stored = await hasher.hash("Right-Password-1");
    expect(await hasher.verify(stored, "")).toBe(false);
  });

  it("does not accept the hash itself as the password", async () => {
    const stored = await hasher.hash("Right-Password-1");
    expect(await hasher.verify(stored, stored)).toBe(false);
  });

  it("works with unicode, emoji and the longest allowed password", async () => {
    for (const password of ["пароль-Ёж-123", "🔑🔒-pass-word", "x".repeat(128)]) {
      const stored = await hasher.hash(password);
      expect(await hasher.verify(stored, password)).toBe(true);
      expect(await hasher.verify(stored, `${password}!`)).toBe(false);
    }
  });

  it("verifies hashes made by the seed, which uses the library's default settings", async () => {
    const seedStyleHash = await plainArgon2("Admin-Demo-Pass-1");
    expect(await hasher.verify(seedStyleHash, "Admin-Demo-Pass-1")).toBe(true);
    expect(await hasher.verify(seedStyleHash, "Admin-Demo-Pass-2")).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["plain text", "not-a-hash"],
    ["a plaintext password stored by mistake", "Right-Password-1"],
    ["a bcrypt hash", "$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345"],
    ["a cut-off argon2 hash", "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ"],
  ])("returns false, and does not throw, for a stored value that is %s", async (_name, broken) => {
    await expect(hasher.verify(broken, "Right-Password-1")).resolves.toBe(false);
  });

  it("refuses the stored plaintext even when the typed password is identical to it", async () => {
    // A bug that stored passwords unhashed must not turn into "login works".
    expect(await hasher.verify("Right-Password-1", "Right-Password-1")).toBe(false);
  });
});

describe("verifyNothing (login for an email with no account)", () => {
  it("always says no", async () => {
    expect(await hasher.verifyNothing("anything")).toBe(false);
    expect(await hasher.verifyNothing("")).toBe(false);
  });

  it("takes about as long as checking a real hash, so response time does not reveal who is registered", async () => {
    const stored = await hasher.hash("Right-Password-1");
    await hasher.verifyNothing("warm up"); // the first call also makes the decoy hash

    // One at a time, five times each, and compare the middle values to ignore a slow outlier.
    const real: number[] = [];
    const missing: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      real.push(await timeOf(() => hasher.verify(stored, "wrong-one")));
      missing.push(await timeOf(() => hasher.verifyNothing("wrong-one")));
    }

    // A skipped check would take about 0 ms; the real work is tens of milliseconds.
    expect(median(missing)).toBeGreaterThan(median(real) * 0.5);
    expect(median(missing)).toBeLessThan(median(real) * 2);
  });
});
