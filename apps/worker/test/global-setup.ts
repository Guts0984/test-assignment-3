import { createDb } from "@app/db";
import { migrateDatabase } from "@app/db/migrate";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import type { TestProject } from "vitest/node";

/**
 * Starts ONE Postgres and ONE Redis for the whole test run (starting them per file is slow).
 * The database is migrated once and kept as a template; every test file gets its own copy of it.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer("postgres:16-alpine").withDatabase("template_app").start(),
    new RedisContainer("redis:7-alpine").start(),
  ]);

  const migrator = createDb(postgres.getConnectionUri(), { max: 1 });
  await migrateDatabase(migrator.db);
  await migrator.close(); // a template database must have no open connections

  project.provide("pgBaseUrl", postgres.getConnectionUri());
  project.provide("pgTemplateDb", "template_app");
  project.provide("redisUrl", redis.getConnectionUrl());

  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    pgBaseUrl: string;
    pgTemplateDb: string;
    redisUrl: string;
  }
}
