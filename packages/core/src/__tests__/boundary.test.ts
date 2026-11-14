import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { afterEach, describe, expect, it } from "vitest";
import { findBoundaryViolations, formatViolation } from "./helpers/boundary.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const coreSrc = join(repoRoot, "packages/core/src");

const temps: string[] = [];
function tempPackage(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gaugeline-boundary-"));
  temps.push(root);
  const src = join(root, "packages/core/src");
  for (const [name, body] of Object.entries(files)) {
    const full = join(src, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  mkdirSync(src, { recursive: true });
  return src;
}
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("findBoundaryViolations: unit", () => {
  it("a clean file returns []", () => {
    const src = tempPackage({
      "a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
      "b.ts": "export const b = 1;\n",
    });
    expect(findBoundaryViolations(src)).toEqual([]);
  });

  it("an import of the CLI source returns one violation with file and line", () => {
    const src = tempPackage({
      "x.ts": '// header\nimport { run } from "../../cli/src/main";\nrun();\n',
    });
    const v = findBoundaryViolations(src);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ line: 2, kind: "imports-cli", detail: "../../cli/src/main" });
    expect(v[0]?.file.endsWith("x.ts")).toBe(true);
  });

  it('a file with: import { exit } from "node:process" returns one violation', () => {
    const src = tempPackage({
      "p.ts": 'import { exit } from "node:process";\nexport const e = exit;\n',
    });
    expect(findBoundaryViolations(src)).toEqual([
      expect.objectContaining({ line: 1, kind: "imports-process-exit" }),
    ]);
  });

  it("a file that calls process.exit(2) inside a nested function returns one violation", () => {
    const src = tempPackage({
      "y.ts":
        "export function outer() {\n  function inner() {\n    process.exit(2);\n  }\n  return inner;\n}\n",
    });
    expect(findBoundaryViolations(src)).toEqual([
      expect.objectContaining({ line: 3, kind: "process-exit", detail: "process.exit" }),
    ]);
  });

  it("importing argv from node:process is allowed", () => {
    const src = tempPackage({
      "q.ts": 'import { env } from "node:process";\nexport const e = env;\n',
    });
    expect(findBoundaryViolations(src)).toEqual([]);
  });

  it('export * from "@gaugeline/cli" is caught (export-from, not only import)', () => {
    const src = tempPackage({ "z.ts": 'export * from "@gaugeline/cli";\n' });
    expect(findBoundaryViolations(src)).toEqual([
      expect.objectContaining({ kind: "imports-cli", line: 1 }),
    ]);
  });

  it("formatViolation names the lint rules so the two locks stay in step", () => {
    const src = tempPackage({ "z.ts": 'export * from "gaugeline";\n' });
    const [v] = findBoundaryViolations(src);
    expect(v && formatViolation(v, src)).toContain("no-restricted-imports");
  });
});

describe("findBoundaryViolations: edge cases", () => {
  it('dynamic import("../../cli/src/x") is caught by the walker', () => {
    const src = tempPackage({
      "d.ts": 'export async function f() {\n  return import(\n    "../../cli/src/x"\n  );\n}\n',
    });
    expect(findBoundaryViolations(src)).toEqual([
      expect.objectContaining({ kind: "imports-cli", line: 2 }),
    ]);
  });

  it("import type { X } from the CLI is still a violation", () => {
    const src = tempPackage({
      "t.ts": 'import type { X } from "gaugeline";\nexport type Y = X;\n',
    });
    expect(findBoundaryViolations(src)).toHaveLength(1);
  });

  it("a comment or string containing process.exit is not a violation", () => {
    const src = tempPackage({
      "c.ts": '// process.exit(1)\nexport const s = "process.exit(1)";\n/* process.exit */\n',
    });
    expect(findBoundaryViolations(src)).toEqual([]);
  });

  it("a relative path that leaves packages/core is a violation", () => {
    const src = tempPackage({
      "deep/e.ts": 'import { x } from "../../../../scripts/x.js";\nexport { x };\n',
    });
    expect(findBoundaryViolations(src)).toEqual([
      expect.objectContaining({ kind: "import-outside-package" }),
    ]);
  });

  it("a file under __tests__ may use console and process.exit and is skipped by the walker", () => {
    const src = tempPackage({
      "__tests__/t.test.ts": 'import "gaugeline";\nconsole.log(1);\nprocess.exit(1);\n',
    });
    expect(findBoundaryViolations(src)).toEqual([]);
  });
});

describe("boundary: integration", () => {
  it("passes against the real packages/core/src", () => {
    const v = findBoundaryViolations(coreSrc);
    expect(v.map((x) => formatViolation(x, repoRoot))).toEqual([]);
  });

  // ESLint 9 supports Node ^18.18.0; the lint job runs on Node 22. Lint-through-API tests
  // only run where ESLint itself is supported.
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  const eslintSupported = major > 18 || (major === 18 && minor >= 18);
  const lint = async (code: string, filePath: string) => {
    const eslint = new ESLint({
      cwd: repoRoot,
      overrideConfig: [
        {
          files: ["**/*.ts"],
          languageOptions: { parserOptions: { projectService: false, project: null } },
          rules: { "@typescript-eslint/no-floating-promises": "off" },
        },
      ],
    });
    const [result] = await eslint.lintText(code, { filePath: join(repoRoot, filePath) });
    return (result?.messages ?? []).map((m) => m.ruleId);
  };

  it.runIf(eslintSupported)("ESLint reports no-console on a core-path file", async () => {
    expect(await lint('console.log("hi");\n', "packages/core/src/fixture.ts")).toContain(
      "no-console",
    );
  });

  it.runIf(eslintSupported)(
    "the same string linted under a packages/cli path reports nothing",
    async () => {
      expect(await lint('console.log("hi");\n', "packages/cli/src/fixture.ts")).toEqual([]);
    },
  );

  it.runIf(eslintSupported)('import { exit } from "node:process" is reported in core', async () => {
    expect(
      await lint(
        'import { exit } from "node:process";\nexit(1);\n',
        "packages/core/src/fixture.ts",
      ),
    ).toContain("no-restricted-imports");
  });

  it.runIf(eslintSupported)(
    "process.exitCode = 1 is flagged by lint; reading process.exitCode is not",
    async () => {
      expect(await lint("process.exitCode = 1;\n", "packages/core/src/fixture.ts")).toContain(
        "no-restricted-syntax",
      );
      expect(
        await lint("export const c = process.exitCode;\n", "packages/core/src/fixture.ts"),
      ).toEqual([]);
    },
  );

  it.runIf(eslintSupported)("an import of the CLI package is reported in core", async () => {
    expect(await lint('import "gaugeline";\n', "packages/core/src/fixture.ts")).toContain(
      "no-restricted-imports",
    );
  });

  it("pnpm format:check exits 0 on the committed tree", () => {
    const prettier = join(repoRoot, "node_modules/prettier/bin/prettier.cjs");
    const r = spawnSync(process.execPath, [prettier, "--check", "."], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // Prettier reads every file in the repository: a Windows runner under a full parallel suite takes
    // well over the 20 seconds a unit test gets.
  }, 180_000);
});
