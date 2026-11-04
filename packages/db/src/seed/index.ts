import { hash } from "@node-rs/argon2";
import { sql } from "drizzle-orm";
import type { Database } from "../client";
import { events, users, type NewUser } from "../schema";
import { generateEvents } from "./generate-events";

export { generateEvents, EVENT_COUNT, SEED_WINDOW_DAYS } from "./generate-events";

export const demoUsers = [
  { email: "admin@example.com", role: "admin" },
  { email: "alice@example.com", role: "user" },
  { email: "bob@example.com", role: "user" },
] as const satisfies readonly Pick<NewUser, "email" | "role">[];

export interface SeedPasswords {
  admin: string;
  alice: string;
  bob: string;
}

export interface SeedOptions {
  passwords: SeedPasswords;
  now?: Date;
}

async function seedUsers(db: Database, passwords: SeedPasswords): Promise<number> {
  const byEmail: Record<(typeof demoUsers)[number]["email"], string> = {
    "admin@example.com": passwords.admin,
    "alice@example.com": passwords.alice,
    "bob@example.com": passwords.bob,
  };

  const rows: NewUser[] = await Promise.all(
    demoUsers.map(async ({ email, role }) => ({
      email,
      role,
      passwordHash: await hash(byEmail[email]),
    })),
  );

  const inserted = await db
    .insert(users)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: users.id });
  return inserted.length;
}

async function seedEvents(db: Database, now: Date): Promise<number> {
  const [existing] = await db.select({ one: sql<number>`1` }).from(events).limit(1);
  if (existing) return 0;

  const rows = generateEvents(now);
  await db.insert(events).values(rows);
  return rows.length;
}

/**
 * Fills an empty database with demo users and events. Safe to run again: users are matched
 * by email and events are only added when the table is empty, so nothing is duplicated.
 */
export async function seedIfEmpty(
  db: Database,
  { passwords, now = new Date() }: SeedOptions,
): Promise<{ users: number; events: number }> {
  const usersAdded = await seedUsers(db, passwords);
  const eventsAdded = await seedEvents(db, now);
  return { users: usersAdded, events: eventsAdded };
}
