import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TODO_MARK,
  createdPaths,
  planNewAdapter,
  readAdapterState,
  render,
  resolveOptions,
  type AdapterRepoState,
  type Vars,
} from "../lib/new-adapter.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const state = (over: Partial<AdapterRepoState> = {}, id = "alpha-rest"): AdapterRepoState => ({
  ...readAdapterState(repoRoot, id),
  ...over,
});
const plan = (opts: Parameters<typeof planNewAdapter>[0], over: Partial<AdapterRepoState> = {}) =>
  planNewAdapter(opts, state(over, opts.id));
const content = (p: ReturnType<typeof plan>, path: string): string =>
  p.find((s) => s.path === path)?.content ?? "";
const known = (): AdapterRepoState["known"] => state().known;
const ADAPTERS = "packages/core/src/adapters";

const VARIANTS = [
  { id: "alpha-rest", read: "rest", key: "read-only" },
  { id: "beta-graphql", read: "graphql", key: "scoped" },
  { id: "gamma-open", read: "rest", key: "none" },
  { id: "delta-live", read: "live-site", key: "none" },
  { id: "epsilon-full", read: "live-site", key: "full-access" },
] as const;

describe("planNewAdapter: unit (no disk)", () => {
  it("plans new files only: the adapter, its entry file, fixture, contract entry, tests, docs page, changeset", () => {
    const p = plan({ id: "alpha-rest", read: "rest", key: "read-only" });
    expect(p.map((s) => s.path)).toEqual([
      `${ADAPTERS}/alpha-rest.ts`,
      `${ADAPTERS}/alpha-rest.entry.ts`,
      `${ADAPTERS}/__tests__/alpha-rest-fixture.ts`,
      `${ADAPTERS}/__tests__/alpha-rest.contract.ts`,
      `${ADAPTERS}/__tests__/alpha-rest-adapter.test.ts`,
      `${ADAPTERS}/__tests__/alpha-rest-docs-example.ts`,
      `${ADAPTERS}/__tests__/alpha-rest-docs.test.ts`,
      "docs/integrations/alpha-rest.md",
      ".changeset/c-alpha-rest.md",
    ]);
    expect(p.every((s) => s.action === "create")).toBe(true);
    expect(createdPaths("alpha-rest")).toEqual(p.map((s) => s.path));
  });

  it("the entry file has the metadata, the lazy loader, the docs row and the page, and never imports the adapter", () => {
    const p = plan({ id: "alpha-rest", read: "rest", key: "read-only" });
    const entry = content(p, `${ADAPTERS}/alpha-rest.entry.ts`);
    expect(entry).toContain("export const ALPHA_REST_DESCRIPTION: AdapterDescription = {");
    expect(entry).toContain('export const ALPHA_REST_TOKEN = "ALPHA_REST_TOKEN";');
    expect(entry).toContain("envVars: [ALPHA_REST_TOKEN],");
    expect(entry).toContain('load: lazy("alpha-rest", async () => {');
    expect(entry).toContain('await import("./alpha-rest.js")');
    expect(entry).not.toMatch(/^import .*from "\.\/alpha-rest\.js"/m);
    expect(entry).toContain('slug: "integrations/alpha-rest"');
    expect(entry).toContain('status: "built"');
    expect(content(p, `${ADAPTERS}/alpha-rest.ts`)).toContain(
      'import { ALPHA_REST_DESCRIPTION } from "./alpha-rest.entry.js";',
    );
    expect(content(p, `${ADAPTERS}/__tests__/alpha-rest.contract.ts`)).toContain(
      "export const contractEntries: readonly ContractEntry[] = [alphaRestEntry];",
    );
  });

  it("a live-site adapter's entry says it reads the sitemap and feeds, and its row says why there is no key", () => {
    const live = content(
      plan({ id: "delta-live", read: "live-site", key: "none" }),
      `${ADAPTERS}/delta-live.entry.ts`,
    );
    expect(live).toContain("settings: { pageReader: true },");
    expect(live).toContain("site: c.site,");
    expect(live).not.toContain("envVars");
    const full = content(
      plan({ id: "epsilon-full", read: "live-site", key: "full-access" }),
      `${ADAPTERS}/epsilon-full.entry.ts`,
    );
    expect(full).toContain("Epsilon Full's own key can also change the project");
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
      `${ADAPTERS}/alpha-rest.ts`,
      `${ADAPTERS}/alpha-rest.entry.ts`,
      "docs/integrations/alpha-rest.md",
      ".changeset/c-alpha-rest.md",
      `${ADAPTERS}/__tests__/alpha-rest-fixture.ts`,
    ])
      expect(content(p, path), path).toContain(TODO_MARK);
  });

  it("the defaults: a REST adapter with a read-only key; a key that can write means live site", () => {
    expect(resolveOptions({ id: "x-cms" }, known())).toMatchObject({
      read: "rest",
      key: "read-only",
    });
    expect(resolveOptions({ id: "x-cms", key: "full-access" }, known())).toMatchObject({
      read: "live-site",
      key: "full-access",
    });
    expect(resolveOptions({ id: "x-cms", read: "live-site" }, known())).toMatchObject({
      key: "none",
    });
  });

  it("refuses combinations the read-only rule does not allow, and says what to use", () => {
    expect(() =>
      resolveOptions({ id: "x-cms", read: "rest", key: "full-access" }, known()),
    ).toThrow(/--read live-site/);
    expect(() =>
      resolveOptions({ id: "x-cms", read: "live-site", key: "scoped" }, known()),
    ).toThrow(/--read rest or --read graphql/);
    expect(() => resolveOptions({ id: "x-cms", read: "soap" }, known())).toThrow(
      "rest, graphql, live-site",
    );
    expect(() => resolveOptions({ id: "x-cms", key: "admin" }, known())).toThrow(
      "read-only, scoped, full-access, none",
    );
  });

  it("refuses an id that is not kebab-case, one that exists, and one that another branch builds", () => {
    expect(() => resolveOptions({ id: "Strapi_Cloud" }, known())).toThrow(/lower-case letters/);
    expect(() => resolveOptions({ id: "webflow" }, known())).toThrow(/already exists/);
    // The builders' ids live in builder-platforms.ts, not in an entry file of their own.
    expect(() => resolveOptions({ id: "squarespace" }, known())).toThrow(/already exists/);
    expect(() => resolveOptions({ id: "generic-api" }, known())).toThrow(/C-14/);
    expect(() => resolveOptions({ id: "x-cms", name: 'Bad "name"' }, known())).toThrow(
      /plain name/,
    );
    expect(() => resolveOptions({ id: "x-cms", name: "Cost $NAME$" }, known())).toThrow(
      /plain name/,
    );
  });

  it("reads the repository: built adapters, the builders, and the planned ones with their names", () => {
    const k = known();
    expect(k.find((x) => x.id === "wordpress")).toEqual({ id: "wordpress" });
    expect(k.map((x) => x.id)).toEqual(expect.arrayContaining(["contentful", "framer", "duda"]));
    // A planned adapter carries its planned name; a built one has none (which ones are planned changes with every merge).
    const planned = k.filter((x) => x.plannedName !== undefined);
    // Once every planned adapter is built there are none left; each one that is has a name.
    for (const x of planned) expect(x.plannedName?.length).toBeGreaterThan(0);
    expect(k.find((x) => x.id === "generic-api")).toEqual({ id: "generic-api" });
  });

  it("an adapter that is planned takes its planned name and replaces only its placeholder entry", () => {
    const p = planNewAdapter(
      { id: "zeta" },
      { known: [{ id: "zeta", plannedName: "Zeta CMS" }], files: new Set() },
    );
    expect(p.filter((s) => s.action === "replace").map((s) => s.path)).toEqual([
      `${ADAPTERS}/zeta.entry.ts`,
    ]);
    expect(content(p, `${ADAPTERS}/zeta.entry.ts`)).toContain('name: "Zeta CMS"');
    expect(content(p, "docs/integrations/zeta.md")).toContain("Zeta CMS");
  });

  it("a file that already exists stops the plan before anything is written", () => {
    expect(() =>
      plan({ id: "alpha-rest" }, { files: new Set(["docs/integrations/alpha-rest.md"]) }),
    ).toThrow(/already exists. Nothing was written/);
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
      const source = content(plan(variant), `${ADAPTERS}/${variant.id}.ts`);
      expect(source).not.toMatch(/method:\s*["']?(POST|PUT|PATCH|DELETE)/i);
      expect(source).not.toContain("fetch(");
      expect(source).toContain("ADR-0006");
      expect(source).toContain("queryAllow");
      expect(source).toContain("API_ORIGIN");
      if (variant.key === "none") expect(source).not.toContain("authorization");
      else expect(source).toContain("authorization: `Bearer ${key}`");
      if (variant.read === "graphql") expect(source).toContain("readOnly(");
    },
  );

  it("a live-site adapter reads no key and builds no request of its own", () => {
    const source = content(plan(VARIANTS[3]), `${ADAPTERS}/delta-live.ts`);
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
 *
 * Time: every spawned process has a timeout and is killed with SIGKILL when it passes it (a hung child on a slow
 * Windows runner must fail this file, not hold the whole run), and typecheck, lint and prettier each run once
 * over all five adapters, never once for each.
 */
let temp = "";
/** The files under these folders before anything is generated, to prove what the generator touched. */
const WATCHED = [ADAPTERS, "docs", ".changeset"];
const snapshot = new Map<string, string>();

/**
 * Every file under a folder. It does not follow links and never enters node_modules: the copy's node_modules is a
 * link to the real one (hundreds of thousands of files), and statting them all took 39 s on a Windows runner.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const rel = (full: string) => full.slice(temp.length + 1).replaceAll("\\", "/");

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
    // Core's document tests build their PDFs and read them with the documents package.
    "packages/documents",
    "packages/fixtures",
    "docs/integrations",
    "docs/nav.ts",
    "docs/adapter-pages.generated.ts",
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
  for (const dir of WATCHED)
    if (existsSync(join(temp, dir)))
      for (const f of walk(join(temp, dir))) snapshot.set(rel(f), readFileSync(f, "utf8"));
}, 120_000);
afterAll(() => rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

/** Run a process in the copy. It has a time limit and is killed with SIGKILL past it; a kill is a failure. */
function run(args: string[], timeoutMs: number, cwd = temp): SpawnSyncReturns<string> {
  const r = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, INIT_CWD: "" },
  });
  if (r.error)
    throw new Error(`${args.join(" ")} did not finish in ${timeoutMs} ms: ${r.error.message}`);
  return r;
}
const SHORT = 120_000;
const LONG = 200_000;
const TEST = 240_000;
const tsx = (script: string, args: string[], cwd = temp) =>
  run([join(temp, "node_modules/tsx/dist/cli.mjs"), join(temp, script), ...args], SHORT, cwd);
const vitest = (files: string[]) =>
  run([join(temp, "node_modules/vitest/vitest.mjs"), "run", ...files], LONG);

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
      expect(lines.slice(0, 9)).toEqual(plan(variant).map((s) => s.path));
      expect(r.stdout).toContain("Next:");
      expect(existsSync(join(temp, `${ADAPTERS}/${variant.id}.ts`))).toBe(true);
    },
    TEST,
  );

  it("writes new files only: of the files that existed, only the four generated ones changed", () => {
    const changed = [...snapshot]
      .filter(([path, text]) => readFileSync(join(temp, path), "utf8") !== text)
      .map(([path]) => path)
      .sort();
    expect(changed).toEqual(
      [
        `${ADAPTERS}/__tests__/contracts.generated.ts`,
        `${ADAPTERS}/entries.generated.ts`,
        "docs/adapter-pages.generated.ts",
        "docs/integrations/index.md",
      ].sort(),
    );
    const added = WATCHED.filter((d) => existsSync(join(temp, d)))
      .flatMap((d) => walk(join(temp, d)))
      .map(rel)
      .filter((p) => !snapshot.has(p))
      .sort();
    expect(added).toEqual(VARIANTS.flatMap((v) => createdPaths(v.id)).sort());
  });

  it(
    "the new entries are in the generated index, the contracts, the docs table and the sidebar, and gen:adapters --check agrees",
    () => {
      const entries = readFileSync(join(temp, `${ADAPTERS}/entries.generated.ts`), "utf8");
      const contracts = readFileSync(
        join(temp, `${ADAPTERS}/__tests__/contracts.generated.ts`),
        "utf8",
      );
      const table = readFileSync(join(temp, "docs/integrations/index.md"), "utf8");
      const pages = readFileSync(join(temp, "docs/adapter-pages.generated.ts"), "utf8");
      for (const v of VARIANTS) {
        expect(entries).toContain(`./${v.id}.entry.js`);
        expect(contracts).toContain(`./${v.id}.contract.js`);
        expect(pages).toContain(`integrations/${v.id}`);
      }
      expect(table).toMatch(/\| Alpha Rest +\| built +\|/);
      expect(table).toMatch(
        /\| Epsilon Full +\| built +\| read-only \(no key at all: it reads the live site only; Epsilon Full's own key can also change the project/,
      );
      const check = tsx("scripts/gen-adapters.ts", ["--check"]);
      expect(check.stderr).toBe("");
      expect(check.status).toBe(0);
    },
    TEST,
  );

  it(
    "the generated files are formatted, linted and typecheck, checked once over all five adapters",
    () => {
      const files = [
        ...VARIANTS.flatMap((v) => createdPaths(v.id)),
        "docs/nav.ts",
        `${ADAPTERS}/entries.generated.ts`,
        `${ADAPTERS}/__tests__/contracts.generated.ts`,
        "docs/adapter-pages.generated.ts",
        "docs/integrations/index.md",
      ].filter((p) => /\.(ts|md)$/.test(p));
      const prettier = run(
        [join(temp, "node_modules/prettier/bin/prettier.cjs"), "--check", ...files],
        SHORT,
      );
      expect(prettier.status, prettier.stdout + prettier.stderr).toBe(0);

      const tsc = run(
        [join(temp, "node_modules/typescript/bin/tsc"), "-p", "packages/core/tsconfig.json"],
        LONG,
      );
      expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0);

      const lint = run(
        [
          join(temp, "node_modules/eslint/bin/eslint.js"),
          ...files.filter((p) => p.endsWith(".ts") && p.startsWith("packages/")),
        ],
        LONG,
      );
      expect(lint.status, lint.stdout + lint.stderr).toBe(0);
    },
    TEST,
  );

  it(
    "the generated adapters pass the contract suite unchanged, with their fixtures",
    () => {
      const r = vitest([`${ADAPTERS}/__tests__/contract.test.ts`, "--reporter=verbose"]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      for (const v of VARIANTS) expect(r.stdout + r.stderr).toContain(v.id);
    },
    TEST,
  );

  it(
    "their own tests, docs example and docs test, the loader rule and the registry pass too, with the markers in place",
    () => {
      const r = vitest([
        ...VARIANTS.flatMap((v) => [
          `${ADAPTERS}/__tests__/${v.id}-adapter.test.ts`,
          `${ADAPTERS}/__tests__/${v.id}-docs.test.ts`,
        ]),
        `${ADAPTERS}/__tests__/lazy.test.ts`,
      ]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    },
    TEST,
  );

  it(
    "the docs page example prints: tsx on the docs example gives the JSON the page will hold",
    () => {
      const r = tsx(`${ADAPTERS}/__tests__/alpha-rest-docs-example.ts`, []);
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(out["published classes"]).toHaveLength(2);
    },
    TEST,
  );

  it(
    "the merge guard fails while any marker is left, naming the files",
    () => {
      const r = vitest([`${ADAPTERS}/__tests__/no-todo.test.ts`]);
      expect(r.status).toBe(1);
      const out = r.stdout + r.stderr;
      expect(out).toContain(`${ADAPTERS}/alpha-rest.ts`);
      expect(out).toContain(`${ADAPTERS}/alpha-rest.entry.ts`);
      expect(out).toContain("docs/integrations/delta-live.md");
      expect(out).toContain(".changeset/c-epsilon-full.md");
    },
    TEST,
  );

  it(
    "running the generator twice with the same id: the second run exits 1 and writes nothing",
    () => {
      const before = readdirSync(join(temp, ".changeset")).sort();
      const r = tsx("scripts/new-adapter.ts", ["alpha-rest"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('An adapter with the id "alpha-rest" already exists.');
      expect(readdirSync(join(temp, ".changeset")).sort()).toEqual(before);
    },
    TEST,
  );

  it(
    "run from a subdirectory of the repo: paths still resolve from the workspace root",
    () => {
      const r = tsx("scripts/new-adapter.ts", ["sub-dir-cms"], join(temp, "packages/core/src"));
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(join(temp, `${ADAPTERS}/sub-dir-cms.ts`))).toBe(true);
      expect(existsSync(join(temp, "packages/core/src/packages"))).toBe(false);
    },
    TEST,
  );

  it(
    "a planned adapter's placeholder entry is replaced by the built one, keeping its name, and nothing else is edited",
    () => {
      writeFileSync(
        join(temp, `${ADAPTERS}/zeta.entry.ts`),
        `import type { AdapterEntry } from "./entry.js";

export const entries: readonly AdapterEntry[] = [
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
      expect(tsx("scripts/gen-adapters.ts", []).status).toBe(0);
      const r = tsx("scripts/new-adapter.ts", ["zeta"]);
      expect(r.status, r.stderr).toBe(0);
      const entry = readFileSync(join(temp, `${ADAPTERS}/zeta.entry.ts`), "utf8");
      expect(entry).toContain('name: "Zeta CMS"');
      expect(entry).toContain('status: "built"');
      expect(entry).not.toContain("planned");
      const table = readFileSync(join(temp, "docs/integrations/index.md"), "utf8");
      expect(table).toMatch(/\| Zeta CMS +\| built +\|/);
      expect(table).not.toMatch(/\| Zeta CMS +\| planned/);
      const check = tsx("scripts/gen-adapters.ts", ["--check"]);
      expect(check.status, check.stderr).toBe(0);
    },
    TEST,
  );

  it(
    "a refused combination exits 1 with the reason and writes nothing",
    () => {
      const r = tsx("scripts/new-adapter.ts", [
        "bad-combo",
        "--read",
        "rest",
        "--key",
        "full-access",
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("--read live-site");
      expect(existsSync(join(temp, `${ADAPTERS}/bad-combo.ts`))).toBe(false);
    },
    TEST,
  );
});
