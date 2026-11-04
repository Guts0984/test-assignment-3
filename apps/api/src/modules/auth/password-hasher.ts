import { randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/**
 * The library's default algorithm is argon2id (a test checks this). Settings follow OWASP's
 * advice: 19 MiB of memory, 2 passes, 1 thread. They are written inside every hash, so they can
 * be raised later and old hashes still verify.
 */
const options = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export interface PasswordHasher {
  /** Turns a password into a hash that is safe to store. The same password gives a different hash each time. */
  hash: (password: string) => Promise<string>;
  /** True only if `password` is the one that made `storedHash`. A damaged or foreign hash is simply false. */
  verify: (storedHash: string, password: string) => Promise<boolean>;
  /**
   * For a login with an email that has no account: does the same slow work as a real check and
   * always answers false. Without it, such a login is much faster and reveals who is registered.
   */
  verifyNothing: (password: string) => Promise<false>;
}

export function createPasswordHasher(): PasswordHasher {
  // A real hash of a random password nobody knows; made the first time it is needed.
  let decoy: Promise<string> | undefined;
  const getDecoy = () => (decoy ??= hash(randomBytes(24).toString("hex"), options));

  async function verifyHash(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch {
      return false; // not an argon2 hash, or damaged: nobody can log in with it
    }
  }

  return {
    hash: (password) => hash(password, options),
    verify: verifyHash,
    verifyNothing: async (password) => {
      await verifyHash(await getDecoy(), password);
      return false;
    },
  };
}
