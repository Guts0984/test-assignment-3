import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export type { Pool as DbPool } from "pg";
import * as schema from "./schema";

export interface DbOptions {
  max?: number;
}

export function createDb(connectionString: string, options: DbOptions = {}) {
  const pool = new Pool({ connectionString, max: options.max ?? 10 });
  const db = drizzle(pool, { schema, casing: "snake_case" });
  return { db, pool, close: () => pool.end() };
}

export type Database = NodePgDatabase<typeof schema>;
