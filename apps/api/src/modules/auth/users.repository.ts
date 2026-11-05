import { pgErrorCodes, readPgError, users, type Database, type User } from "@app/db";
import { eq, sql } from "drizzle-orm";

export interface UsersRepository {
  /** `email` must already be normalized (trimmed, lower-case). */
  findByEmail: (email: string) => Promise<User | undefined>;
  findById: (id: string) => Promise<User | undefined>;
  /** New users are always plain users. Returns "email_taken" if the address is already registered. */
  create: (input: { email: string; passwordHash: string }) => Promise<User | "email_taken">;
}

export function createUsersRepository(db: Database): UsersRepository {
  return {
    async findByEmail(email) {
      // Matches the index on lower(email), so the lookup is fast and case-insensitive.
      const [row] = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
        .limit(1);
      return row;
    },

    async findById(id) {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row;
    },

    async create({ email, passwordHash }) {
      try {
        const [row] = await db.insert(users).values({ email, passwordHash, role: "user" }).returning();
        if (!row) throw new Error("insert returned no row");
        return row;
      } catch (error) {
        // Two people registering the same address at once: the database lets one of them in.
        if (readPgError(error)?.code === pgErrorCodes.uniqueViolation) return "email_taken";
        throw error;
      }
    },
  };
}
