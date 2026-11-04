// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "gaugeline", message: "packages/core must not import the CLI package." }],
          patterns: [
            {
              group: ["**/cli/**", "**/packages/cli", "@gaugeline/cli", "@gaugeline/cli/*"],
              message: "packages/core must not import from packages/cli.",
            },
          ],
        },
      ],
    },
  },
);
