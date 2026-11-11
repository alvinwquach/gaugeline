import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TODO_MARK,
  createdPaths,
  planNewAdapter,
  render,
  resolveOptions,
  type AdapterRepoState,
  type Vars,
} from "../lib/new-adapter.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8").replace(/\r\n/g, "\n");
const state = (over: Partial<AdapterRepoState> = {}): AdapterRepoState => ({
  registrySource: read("packages/core/src/adapters/registry.ts"),
  entriesSource: read("packages/core/src/adapters/__tests__/entries.ts"),
  indexSource: read("packages/core/src/adapters/index.ts"),
  docsIndexSource: read("docs/integrations/index.md"),
  navSource: read("docs/nav.ts"),
  files: new Set(),
  ...over,
});
const plan = (opts: Parameters<typeof planNewAdapter>[0], over: Partial<AdapterRepoState> = {}) =>
  planNewAdapter(opts, state(over));
const content = (p: ReturnType<typeof plan>, path: string): string =>
  p.find((s) => s.path === path)?.content ?? "";

const VARIANTS = [
  { id: "alpha-rest", read: "rest", key: "read-only" },
  { id: "beta-graphql", read: "graphql", key: "scoped" },
  { id: "gamma-open", read: "rest", key: "none" },
  { id: "delta-live", read: "live-site", key: "none" },
  { id: "epsilon-full", read: "live-site", key: "full-access" },
] as const;

describe("planNewAdapter: unit (no disk)", () => {
  it("plans the adapter, its fixture, tests, docs page, changeset and the five shared files", () => {
    const p = plan({ id: "alpha-rest", read: "rest", key: "read-only" });
    expect(p.map((s) => s.path)).toEqual([
      "packages/core/src/adapters/alpha-rest.ts",
      "packages/core/src/adapters/__tests__/alpha-rest-fixture.ts",
      "packages/core/src/adapters/__tests__/alpha-rest-adapter.test.ts",
      "packages/core/src/adapters/__tests__/alpha-rest-docs-example.ts",
      "packages/core/src/adapters/__tests__/alpha-rest-docs.test.ts",
      "docs/integrations/alpha-rest.md",
      ".changeset/c-alpha-rest.md",
      "packages/core/src/adapters/registry.ts",
      "packages/core/src/adapters/__tests__/entries.ts",
      "packages/core/src/adapters/index.ts",
      "docs/integrations/index.md",
      "docs/nav.ts",
    ]);
    expect(p.filter((s) => s.action === "create")).toHaveLength(7);
    expect(createdPaths("alpha-rest")).toEqual(
      p.filter((s) => s.action === "create").map((s) => s.path),
    );
  });

  it("registers the adapter, its contract entry, its exports, its docs row and its nav entry", () => {
    const p = plan({ id: "alpha-rest", read: "rest", key: "read-only" });
    const registry = content(p, "packages/core/src/adapters/registry.ts");
    expect(registry).toContain(
      'import { ALPHA_REST_DESCRIPTION, createAlphaRestAdapter } from "./alpha-rest.js";',
    );
    expect(registry).toContain('"alpha-rest",');
    expect(registry).toContain("describe: ALPHA_REST_DESCRIPTION,");
    // The BUILT_ADAPTERS map still closes where it did, with the new row last.
    expect(registry.indexOf("ALPHA_REST_DESCRIPTION,\n")).toBeLessThan(
      registry.indexOf("/** A content system the docs list"),
    );
    const entries = content(p, "packages/core/src/adapters/__tests__/entries.ts");
    expect(entries).toContain("export const alphaRestEntry: ContractEntry = {");
    expect(entries).toMatch(/alphaRestEntry,\n\];/);
    expect(content(p, "packages/core/src/adapters/index.ts")).toContain(
      'export { ALPHA_REST_API, ALPHA_REST_DESCRIPTION, ALPHA_REST_LIMITS, ALPHA_REST_PAGE_SIZE, ALPHA_REST_TOKEN, createAlphaRestAdapter } from "./alpha-rest.js";',
    );
    expect(content(p, "docs/integrations/index.md")).toMatch(
      /\| Alpha Rest \| built \| read-only \(TODO\(new:adapter\) /,
    );
    expect(content(p, "docs/nav.ts")).toContain('slug: "integrations/alpha-rest"');
  });

  it("the page opens with what the adapter reads and the narrowest key, and has the example slot", () => {
    const page = content(plan({ id: "alpha-rest" }), "docs/integrations/alpha-rest.md");
    expect([...page.matchAll(/^## (.+)$/gm)].map((m) => m[1])[0]).toBe(
      "What this adapter reads, and the narrowest key",
    );
    expect(page).toContain("Documentation checked on: TODO(new:adapter)");
    expect(page).toMatch(/^## Example: a yoga studio on Alpha Rest$/m);
    expect(page).toMatch(/^## What cannot be checked$/m);
    expect(page).toContain("[docs]");
  });

  it("every piece of text still to be written carries the marker, so nothing ships unfinished", () => {
    const p = plan({ id: "alpha-rest" });
    for (const path of [
      "packages/core/src/adapters/alpha-rest.ts",
      "docs/integrations/alpha-rest.md",
      ".changeset/c-alpha-rest.md",
      "packages/core/src/adapters/__tests__/alpha-rest-fixture.ts",
    ])
      expect(content(p, path), path).toContain(TODO_MARK);
  });

  it("the defaults: a REST adapter with a read-only key; a key that can write means live site", () => {
    expect(resolveOptions({ id: "x-cms" }, state().registrySource)).toMatchObject({
      read: "rest",
      key: "read-only",
    });
    expect(
      resolveOptions({ id: "x-cms", key: "full-access" }, state().registrySource),
    ).toMatchObject({
      read: "live-site",
      key: "full-access",
    });
    expect(
      resolveOptions({ id: "x-cms", read: "live-site" }, state().registrySource),
    ).toMatchObject({
      key: "none",
    });
  });

  it("refuses combinations the read-only rule does not allow, and says what to use", () => {
    const reg = state().registrySource;
    expect(() => resolveOptions({ id: "x-cms", read: "rest", key: "full-access" }, reg)).toThrow(
      /--read live-site/,
    );
    expect(() => resolveOptions({ id: "x-cms", read: "live-site", key: "scoped" }, reg)).toThrow(
      /--read rest or --read graphql/,
    );
    expect(() => resolveOptions({ id: "x-cms", read: "soap" }, reg)).toThrow(
      "rest, graphql, live-site",
    );
    expect(() => resolveOptions({ id: "x-cms", key: "admin" }, reg)).toThrow(
      "read-only, scoped, full-access, none",
    );
  });

  it("refuses an id that is not kebab-case, one that exists, and one that another branch builds", () => {
    const reg = state().registrySource;
    expect(() => resolveOptions({ id: "Strapi_Cloud" }, reg)).toThrow(/lower-case letters/);
    expect(() => resolveOptions({ id: "webflow" }, reg)).toThrow(/already exists/);
    expect(() => resolveOptions({ id: "generic-api" }, reg)).toThrow(/C-14/);
    expect(() => resolveOptions({ id: "x-cms", name: 'Bad "name"' }, reg)).toThrow(/plain name/);
    expect(() => resolveOptions({ id: "x-cms", name: "Cost $NAME$" }, reg)).toThrow(/plain name/);
  });

  it("an adapter that is planned takes its planned row's name and leaves PLANNED_ADAPTERS", () => {
    const reg = state().registrySource;
    const planned = /\{ id: "(\w+)", name: "([^"]+)", branch: "([^"]+)" \},/.exec(
      reg.slice(reg.indexOf("PLANNED_ADAPTERS")),
    );
    expect(planned, "a single-line planned row to test with").not.toBeNull();
    const [, id = "", name = ""] = planned ?? [];
    const p = plan({ id });
    expect(content(p, "packages/core/src/adapters/registry.ts")).not.toContain(
      `{ id: "${id}", name: "${name}"`,
    );
    expect(content(p, "docs/integrations/index.md")).toMatch(
      new RegExp(`\\| ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} +\\| built +\\|`),
    );
    expect(content(p, "docs/integrations/index.md")).not.toMatch(
      new RegExp(`\\| ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} +\\| planned`),
    );
  });

  it("a file that already exists stops the plan before anything is written", () => {
    expect(() =>
      plan({ id: "alpha-rest" }, { files: new Set(["docs/integrations/alpha-rest.md"]) }),
    ).toThrow(/already exists. Nothing was written/);
  });

  it("an edit whose anchor is gone says so instead of guessing", () => {
    expect(() => plan({ id: "alpha-rest" }, { navSource: "export const NAV = [];\n" })).toThrow(
      /integrations pages in docs\/nav.ts/,
    );
    expect(() => plan({ id: "alpha-rest" }, { entriesSource: "export const X = 1;\n" })).toThrow(
      /Nothing was written/,
    );
  });
});

describe("the templates", () => {
  const base: Vars = {
    id: "demo",
    name: "Demo",
    prefix: "DEMO",
    pascal: "Demo",
    camel: "demo",
    read: "rest",
    key: "read-only",
    keyKind: "read-only",
  };

  it("keep the lines of the branch taken, drop the rest, and fill in the variables", () => {
    const t = "a $NAME$\n#if key\nkey\n#else\nnokey\n#end\n#if !live\nrest\n#end\nz $P$\n";
    expect(render(t, base)).toBe("a Demo\nkey\nrest\nz DEMO\n");
    expect(render(t, { ...base, key: "none" })).toBe("a Demo\nnokey\nrest\nz DEMO\n");
    expect(render(t, { ...base, read: "live-site", key: "none" })).toBe("a Demo\nnokey\nz DEMO\n");
  });

  it("nest, and refuse an unknown condition, a missing #end and an unknown variable", () => {
    expect(render("#if rest\n#if key\nboth\n#else\nrest only\n#end\n#end\n", base)).toBe("both\n");
    expect(() => render("#if nonsense\n#end\n", base)).toThrow(/not known/);
    expect(() => render("#if key\n", base)).toThrow(/without #end/);
    expect(() => render("$NOPE$\n", base)).toThrow(/not filled in/);
  });

  it.each(VARIANTS)("render with no unfilled variable: $id ($read, key $key)", (variant) => {
    const p = plan(variant);
    for (const s of p) expect(s.content, s.path).not.toMatch(/\$[A-Z]+\$/);
  });

  it.each(VARIANTS.filter((v) => v.read !== "live-site"))(
    "a REST or GraphQL adapter sends GET only, keeps its key to its own origin, and marks where ADR-0006 goes: $id",
    (variant) => {
      const source = content(plan(variant), `packages/core/src/adapters/${variant.id}.ts`);
      expect(source).not.toMatch(/method:\s*["']?(POST|PUT|PATCH|DELETE)/i);
      expect(source).not.toContain("fetch(");
      expect(source).toContain("ADR-0006");
      expect(source).toContain("queryAllow");
      expect(source).toContain("API_ORIGIN");
      const registry = content(plan(variant), "packages/core/src/adapters/registry.ts");
      expect(registry).toContain("queryAllow");
      if (variant.key === "none") expect(source).not.toContain("authorization");
      else expect(source).toContain("authorization: `Bearer ${key}`");
      if (variant.read === "graphql") expect(source).toContain("readOnly(");
    },
  );

  it("a live-site adapter reads no key and builds no request of its own", () => {
    const source = content(plan(VARIANTS[3]), "packages/core/src/adapters/delta-live.ts");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("authorization");
    expect(source).toContain("createSitemapFeedAdapter");
    const full = content(plan(VARIANTS[4]), "docs/integrations/epsilon-full.md");
    expect(full).toContain("can also change the project");
  });
});

/**
 * A temp copy of the parts of the workspace the generator touches, with the real node_modules linked.
 * Five adapters are generated into it, one for each shape, and the contract suite is run over them.
 */
let temp = "";
beforeAll(() => {
  // The long path: on Windows, tmpdir() can be an 8.3 short name (RUNNER~1) that Vite resolves differently.
  temp = realpathSync.native(mkdtempSync(join(tmpdir(), "gaugeline-newadapter-")));
  const copy = (p: string) =>
    cpSync(join(repoRoot, p), join(temp, p), {
      recursive: true,
      filter: (src) => !/[\\/](dist|node_modules)([\\/]|$)/.test(src),
    });
  for (const p of [
    "package.json",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "tsconfig.json",
    "vitest.config.ts",
    "eslint.config.js",
    ".prettierrc.json",
    ".prettierignore",
    "scripts",
    "packages/core",
    "packages/testkit",
    "packages/fixtures",
    "docs/integrations",
    "docs/nav.ts",
    ".changeset/config.json",
  ])
    if (existsSync(join(repoRoot, p))) copy(p);
  symlinkSync(join(repoRoot, "node_modules"), join(temp, "node_modules"), "junction");
  for (const pkg of ["core", "testkit"])
    symlinkSync(
      join(repoRoot, "packages", pkg, "node_modules"),
      join(temp, "packages", pkg, "node_modules"),
      "junction",
    );
}, 60_000);
afterAll(() => rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const node = (args: string[], cwd = temp) =>
  spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: "" },
  });
const tsx = (script: string, args: string[], cwd = temp) =>
  node([join(temp, "node_modules/tsx/dist/cli.mjs"), join(temp, script), ...args], cwd);
const vitest = (files: string[]) =>
  node([join(temp, "node_modules/vitest/vitest.mjs"), "run", ...files]);

describe("new:adapter: e2e (temp copy of the repo)", () => {
  it.each(VARIANTS)(
    "pnpm new:adapter $id --read $read --key $key prints its paths and the Next lines, exit 0",
    (variant) => {
      const r = tsx("scripts/new-adapter.ts", [
        variant.id,
        "--read",
        variant.read,
        "--key",
        variant.key,
      ]);
      expect(r.status, r.stderr).toBe(0);
      const lines = r.stdout.trimEnd().split("\n");
      expect(lines.slice(0, 12)).toEqual(plan(variant).map((s) => s.path));
      expect(r.stdout).toContain("Next:");
      expect(existsSync(join(temp, `packages/core/src/adapters/${variant.id}.ts`))).toBe(true);
    },
    60_000,
  );

  it("the generated files are formatted the way the repository formats them", () => {
    const files = VARIANTS.flatMap((v) => [...createdPaths(v.id), "docs/nav.ts"]).filter((p) =>
      /\.(ts|md)$/.test(p),
    );
    const r = node([join(temp, "node_modules/prettier/bin/prettier.cjs"), "--check", ...files]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 120_000);

  it("the generated adapters pass the contract suite unchanged, with their fixtures", () => {
    const r = vitest([
      "packages/core/src/adapters/__tests__/contract.test.ts",
      "--reporter=verbose",
    ]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const v of VARIANTS) expect(r.stdout + r.stderr).toContain(v.id);
  }, 180_000);

  it("their own tests, docs example and docs test pass too, with the markers in place", () => {
    const r = vitest(
      VARIANTS.flatMap((v) => [
        `packages/core/src/adapters/__tests__/${v.id}-adapter.test.ts`,
        `packages/core/src/adapters/__tests__/${v.id}-docs.test.ts`,
      ]),
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 180_000);

  it("the docs page example prints: tsx on the docs example gives the JSON the page will hold", () => {
    const r = tsx("packages/core/src/adapters/__tests__/alpha-rest-docs-example.ts", []);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out["published classes"]).toHaveLength(2);
  }, 60_000);

  it("typecheck passes", () => {
    const r = node([
      join(temp, "node_modules/typescript/bin/tsc"),
      "-p",
      "packages/core/tsconfig.json",
    ]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 240_000);

  it("lint passes on the generated files", () => {
    const files = VARIANTS.flatMap((v) => createdPaths(v.id)).filter((p) => p.endsWith(".ts"));
    const r = node([
      join(temp, "node_modules/eslint/bin/eslint.js"),
      ...files,
      "packages/core/src/adapters/registry.ts",
    ]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 240_000);

  it("the merge guard fails while any marker is left, naming the files", () => {
    const r = vitest(["packages/core/src/adapters/__tests__/no-todo.test.ts"]);
    expect(r.status).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toContain("packages/core/src/adapters/alpha-rest.ts");
    expect(out).toContain("docs/integrations/delta-live.md");
    expect(out).toContain(".changeset/c-epsilon-full.md");
  }, 120_000);

  it("running the generator twice with the same id: the second run exits 1 and writes nothing", () => {
    const before = readdirSync(join(temp, ".changeset")).sort();
    const r = tsx("scripts/new-adapter.ts", ["alpha-rest"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('An adapter with the id "alpha-rest" already exists.');
    expect(readdirSync(join(temp, ".changeset")).sort()).toEqual(before);
  }, 60_000);

  it("run from a subdirectory of the repo: paths still resolve from the workspace root", () => {
    const r = tsx("scripts/new-adapter.ts", ["sub-dir-cms"], join(temp, "packages/core/src"));
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(temp, "packages/core/src/adapters/sub-dir-cms.ts"))).toBe(true);
    expect(existsSync(join(temp, "packages/core/src/packages"))).toBe(false);
  }, 60_000);

  it("a refused combination exits 1 with the reason and writes nothing", () => {
    const r = tsx("scripts/new-adapter.ts", [
      "bad-combo",
      "--read",
      "rest",
      "--key",
      "full-access",
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--read live-site");
    expect(existsSync(join(temp, "packages/core/src/adapters/bad-combo.ts"))).toBe(false);
  }, 60_000);
});
