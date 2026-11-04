import { z } from "zod";
import { createDb } from "../client";
import { migrateDatabase } from "../migrate";
import { seedIfEmpty } from "../seed";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SEED_ADMIN_PASSWORD: z.string().min(8),
  SEED_ALICE_PASSWORD: z.string().min(8),
  SEED_BOB_PASSWORD: z.string().min(8),
});

function log(message: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", msg: message, ...extra }));
}

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    console.error(`Invalid configuration for the migrate step:\n${problems.join("\n")}`);
    process.exit(1);
  }
  const env = parsed.data;

  const { db, close } = createDb(env.DATABASE_URL, { max: 2 });
  try {
    await migrateDatabase(db);
    log("migrations applied");

    const added = await seedIfEmpty(db, {
      passwords: {
        admin: env.SEED_ADMIN_PASSWORD,
        alice: env.SEED_ALICE_PASSWORD,
        bob: env.SEED_BOB_PASSWORD,
      },
    });
    log("seed finished", added);
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: "error", msg: "migrate step failed", error: String(error) }));
  process.exit(1);
});
