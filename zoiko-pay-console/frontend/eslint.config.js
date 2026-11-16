import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist", "node_modules", "coverage", "src/assets/*.svg"] },
  js.configs.recommended,
  tseslint.configs.strict,
  reactHooks.configs.flat.recommended,
  {
    languageOptions: { globals: globals.browser },
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "vite.config.ts"],
    languageOptions: { globals: globals.node },
    rules: { "no-console": "off" },
  },
  {
    files: ["src/**/*.test.{ts,tsx}", "src/test/**"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
