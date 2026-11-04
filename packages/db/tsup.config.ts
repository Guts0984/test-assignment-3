import { defineConfig } from "tsup";

// Builds the `migrate` command (migrations + seed) into one file for the Docker image.
export default defineConfig({
  entry: { migrate: "src/bin/migrate.ts" },
  format: ["esm"],
  target: "node22",
  clean: true,
  // Bundle everything except the password hasher, which ships native code.
  noExternal: [/^(?!@node-rs\/argon2$)/],
  // Some bundled packages are CommonJS and call require(); give them one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
