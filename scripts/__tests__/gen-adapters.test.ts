import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0))
    rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function gen(root: string, args: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
      join(repoRoot, "scripts/gen-adapters.ts"),
      ...args,
    ],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, GEN_ADAPTERS_ROOT: root } },
  );
}

/** A copy of the files gen:adapters reads and writes, so a test can add an adapter without touching the repository. */
function copy(): string {
  const root = mkdtempSync(join(tmpdir(), "gaugeline-gen-adapters-"));
  temps.push(root);
  mkdirSync(join(root, "docs/integrations"), { recursive: true });
  cpSync(join(repoRoot, "docs/integrations/index.md"), join(root, "docs/integrations/index.md"));
  cpSync(join(repoRoot, "packages/core/src/adapters"), join(root, "packages/core/src/adapters"), {
    recursive: true,
  });
  return root;
}

const ENTRY_HEAD = 'import type { AdapterEntry } from "./entry.js";\n';

describe("gen:adapters", () => {
  it("is up to date in the repository (the same check CI runs)", () => {
    const r = gen(repoRoot, ["--check"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("an adapter added as one entry file reaches the registry list, the docs table and the sidebar", () => {
    const root = copy();
    writeFileSync(
      join(root, "packages/core/src/adapters/zeta.entry.ts"),
      `${ENTRY_HEAD}export const entries: readonly AdapterEntry[] = [
  {
    id: "zeta",
    name: "Zeta CMS",
    status: "planned",
    branch: "C-99",
    docs: { key: "set when built", reads: "Entries through the Zeta API" },
    page: { slug: "integrations/zeta", title: "Zeta: content checks" },
  },
];
`,
    );
    expect(gen(root, ["--check"]).status).toBe(1);
    expect(gen(root).status).toBe(0);
    expect(
      readFileSync(join(root, "packages/core/src/adapters/entries.generated.ts"), "utf8"),
    ).toContain('import { entries as zeta } from "./zeta.entry.js";');
    expect(readFileSync(join(root, "docs/integrations/index.md"), "utf8")).toMatch(
      /\| Zeta CMS\s+\| planned \(C-99\) \| set when built\s+\| Entries through the Zeta API\s+\|/,
    );
    expect(readFileSync(join(root, "docs/adapter-pages.generated.ts"), "utf8")).toContain(
      '{ slug: "integrations/zeta", title: "Zeta: content checks" }',
    );
    expect(gen(root, ["--check"]).status).toBe(0);
  });

  it("refuses two entries with the same id", () => {
    const root = copy();
    writeFileSync(
      join(root, "packages/core/src/adapters/wordpress2.entry.ts"),
      `${ENTRY_HEAD}export const entries: readonly AdapterEntry[] = [
  { id: "wordpress", name: "WordPress again", status: "planned", branch: "C-98", docs: { key: "a", reads: "b" } },
];
`,
    );
    const r = gen(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('two entries have the id "wordpress"');
  });

  it("an entry file with no `entries` export is an error that names the file", () => {
    const root = copy();
    writeFileSync(
      join(root, "packages/core/src/adapters/broken.entry.ts"),
      "export const x = 1;\n",
    );
    const r = gen(root);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("broken.entry.ts must export `entries`");
  });
});
