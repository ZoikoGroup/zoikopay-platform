import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist", "node_modules", "coverage"] },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // stdout printing can leak payment data; use the pino logger.
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    // Deterministic fixture generator and tests: indices are always within bounds.
    files: ["src/database/fixtures.ts", "src/screens/registry.ts", "test/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    files: ["scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },
);
