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

/** ADR-0001: in core, only the transport may open a connection. */
const NETWORK_IMPORTS = [
  ...["node:http", "http", "node:https", "https"].map((name) => ({
    name,
    message: "Only packages/core/src/transport.ts may make requests (ADR-0001). Use the fetcher.",
  })),
  ...["node:net", "net", "node:tls", "tls"].map((name) => ({
    name,
    importNames: ["connect", "createConnection", "Socket", "TLSSocket"],
    message: "Only packages/core/src/transport.ts may open sockets (ADR-0001). Use the fetcher.",
  })),
];

/** ADR-0010: the writer's connections are packages/writer/src/github/send.ts, gmail/send.ts (X75) and sanity/send.ts (X71), through fetch. */
const WRITER_NETWORK_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"];

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
    files: ["**/*.ts", "**/*.tsx"],
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
      "no-restricted-imports": [
        "error",
        {
          ...CORE_RESTRICTED_IMPORTS,
          paths: [...CORE_RESTRICTED_IMPORTS.paths, ...NETWORK_IMPORTS],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...["fetch", "XMLHttpRequest", "WebSocket", "EventSource"].map((name) => ({
          name,
          message: "Only the fetcher talks to the network (ADR-0001).",
        })),
      ],
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
    // The transport is the one module allowed to open connections (ADR-0001).
    files: ["packages/core/src/transport.ts"],
    rules: { "no-restricted-imports": ["error", CORE_RESTRICTED_IMPORTS] },
  },
  {
    // Notifications POST to the person's own channels, never to the checked site (ADR-0005).
    files: ["packages/core/src/notify/post.ts"],
    rules: { "no-restricted-imports": ["error", CORE_RESTRICTED_IMPORTS] },
  },
  {
    // ADR-0010: in the writer, only github/send.ts, gmail/send.ts and sanity/send.ts may open a connection. An added
    // restriction: it changes nothing for any other package.
    files: ["packages/writer/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["node:http", "http", "node:https", "https", "node:http2", "http2"].map(
            (name) => ({
              name,
              message:
                "Only packages/writer/src/github/send.ts, gmail/send.ts and sanity/send.ts may make requests (ADR-0010).",
            }),
          ),
        },
      ],
      "no-restricted-globals": [
        "error",
        ...WRITER_NETWORK_GLOBALS.map((name) => ({
          name,
          message:
            "Only packages/writer/src/github/send.ts, gmail/send.ts and sanity/send.ts may make requests (ADR-0010).",
        })),
      ],
    },
  },
  {
    // Each named sender calls fetch (and nothing else that opens a connection). X71 adds sanity/send.ts by
    // name, the way G37 added github/send.ts and X75 gmail/send.ts; no rule is loosened for any other file.
    files: [
      "packages/writer/src/github/send.ts",
      "packages/writer/src/gmail/send.ts",
      "packages/writer/src/sanity/send.ts",
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        ...WRITER_NETWORK_GLOBALS.filter((name) => name !== "fetch").map((name) => ({
          name,
          message:
            "Only fetch, in packages/writer/src/github/send.ts, gmail/send.ts and sanity/send.ts (ADR-0010).",
        })),
      ],
    },
  },
  {
    // Tests may print and may reach repository scripts; the walker skips them too.
    files: ["packages/core/src/**/__tests__/**/*.ts"],
    rules: { "no-console": "off", "no-restricted-imports": "off" },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly", require: "readonly" },
    },
  },
  {
    // CommonJS test helpers (node --require preloads) use require by design.
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
