import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createDb } from "../src/client";
import { migrateDatabase } from "../src/migrate";
import { bookings, events, idempotencyKeys, outbox, users, type NewEvent } from "../src/schema";

export interface TestDb extends ReturnType<typeof createDb> {
  container: StartedPostgreSqlContainer;
  stop: () => Promise<void>;
}

export async function startTestDb(max = 10): Promise<TestDb> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const created = createDb(container.getConnectionUri(), { max });
  await migrateDatabase(created.db);
  return {
    ...created,
    container,
    stop: async () => {
      await created.close();
      await container.stop();
    },
  };
}

export async function clearAll({ db }: Pick<TestDb, "db">): Promise<void> {
  await db.delete(outbox);
  await db.delete(idempotencyKeys);
  await db.delete(bookings);
  await db.delete(events);
  await db.delete(users);
}

export const futureDate = (minutes: number): Date => new Date(Date.now() + minutes * 60_000);

export function eventInput(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    title: "Test concert",
    description: "A test event",
    city: "London",
    venue: "Test Hall",
    startsAt: futureDate(60 * 24),
    capacity: 20,
    ...overrides,
  };
}
