import js from "@eslint/js";
import functional from "eslint-plugin-functional";
import tseslint from "typescript-eslint";

const noRelativePackageImports = {
  group: ["**/packages/**"],
  message: "Import shared code through the package name (@app/shared), not a relative path.",
};

const noDeepFeatureImports = {
  group: ["@/features/*/*"],
  message: "Import from the feature's public index (@/features/<name>), not its internals.",
};

const noFeatureImports = {
  group: ["@/features", "@/features/*"],
  message: "shared/ must not depend on features/.",
};

const restrictImports = (...patterns) => ({
  "no-restricted-imports": ["error", { patterns: [noRelativePackageImports, ...patterns] }],
});

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/coverage/**", "**/next-env.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": "allow-with-description", minimumDescriptionLength: 10 },
      ],
      ...restrictImports(),
    },
  },
  {
    // Functional style: plain functions and data, no classes.
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
    plugins: { functional },
    rules: {
      "functional/no-classes": "error",
      "functional/no-class-inheritance": "error",
      "functional/no-this-expressions": "error",
    },
  },
  {
    // Feature-based web app: routes and features talk to a feature only through its index.
    files: ["apps/web/src/app/**/*.{ts,tsx}", "apps/web/src/features/**/*.{ts,tsx}"],
    rules: restrictImports(noDeepFeatureImports),
  },
  {
    files: ["apps/web/src/shared/**/*.{ts,tsx}"],
    rules: restrictImports(noFeatureImports),
  },
);
