import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  noExternal: [/^(?!swagger-ui-express$|swagger-ui-dist$|@node-rs\/argon2$)/],
  // Some bundled packages are CommonJS and call require(); give them one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
