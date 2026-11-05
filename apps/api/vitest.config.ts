import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 180_000, // the first run pulls the Postgres and Redis images
    // Test files share one Postgres and one Redis, so they run one after another.
    fileParallelism: false,
  },
});
