// @ts-check
import js from "@eslint/js";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

/**
 * The core/cli boundary is enforced twice: by the rules below (editor and pre-commit) and by
 * packages/core/src/__tests__/boundary.test.ts (CI, even with --no-verify or eslint-disable).
 * Keep the two in step.
 */
const CORE_RESTRICTED_IMPORTS = {
  paths: [
    {
      name: "node:process",
      importNames: ["default", "exit", "abort", "kill", "exitCode"],
      message:
        "packages/core must not end the process. Return a result; the CLI picks the exit code.",
    },
    {
      name: "process",
      importNames: ["default", "exit", "abort", "kill", "exitCode"],
      message:
        "packages/core must not end the process. Return a result; the CLI picks the exit code.",
    },
    { name: "gaugeline", message: "packages/core must not import the CLI package." },
    { name: "@gaugeline/cli", message: "packages/core must not import the CLI package." },
  ],
  patterns: [
    {
      group: ["@gaugeline/cli/*", "**/packages/cli", "**/packages/cli/**", "**/cli/src/**"],
      message: "packages/core must not import from packages/cli.",
    },
  ],
};

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "packages/fixtures/sites/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Type-aware rules for the package sources.
    files: ["packages/*/src/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: ROOT },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: ["error", "always"],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-console": "error",
      "no-restricted-imports": ["error", CORE_RESTRICTED_IMPORTS],
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "exit",
          message: "packages/core must not call process.exit.",
        },
        {
          object: "process",
          property: "abort",
          message: "packages/core must not call process.abort.",
        },
        {
          object: "process",
          property: "kill",
          message: "packages/core must not call process.kill.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "AssignmentExpression > MemberExpression.left[object.name='process'][property.name='exitCode']",
          message: "packages/core must not set process.exitCode.",
        },
      ],
    },
  },
  {
    // Tests may print and may reach repository scripts; the walker skips them too.
    files: ["packages/core/src/**/__tests__/**/*.ts"],
    rules: { "no-console": "off", "no-restricted-imports": "off" },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
  },
);
