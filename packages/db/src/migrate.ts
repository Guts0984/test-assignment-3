import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client";

//dont push CLI to prod with extracting of migrate function

export const defaultMigrationsFolder = new URL("../migrations", import.meta.url)
  .pathname;

export async function migrateDatabase(
  db: Database,
  migrationsFolder: string = defaultMigrationsFolder,
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
