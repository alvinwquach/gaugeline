import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS } from "../registry.js";

/**
 * The loader rule (CONTRIBUTING, "Writing an adapter"): every adapter has cheap metadata and a loader that
 * imports its module on first use. Nothing outside adapters/<id>*.ts imports an adapter module statically, so
 * the bundler gives each adapter its own chunk and a run that uses WordPress never loads Shopify's code.
 */

const adaptersDir = fileURLToPath(new URL("..", import.meta.url));
const packagesDir = resolve(adaptersDir, "..", "..", "..");

/**
 * The files in adapters/ that every adapter or the CLI may import statically: types, metadata and helpers
 * that load no adapter. Any other .ts file in adapters/ is an adapter module (adapters/<id>*.ts), so a new
 * adapter is covered without touching this list.
 */
const SHARED = new Set([
  "builder-platforms.ts",
  "collect.ts",
  "config.ts",
  "fingerprint.ts",
  "index.ts",
  "meta.ts",
  "registry.ts",
  "types.ts",
]);

const adapterModules = readdirSync(adaptersDir)
  .filter((f) => f.endsWith(".ts") && !SHARED.has(f))
  .map((f) => join(adaptersDir, f));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__")
      continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** The files a source file imports or re-exports at run time: type-only imports are erased and do not count. */
function staticImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
  );
  const found: string[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings;
      const onlyTypes =
        clause !== undefined &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((e) => e.isTypeOnly);
      if (!onlyTypes) found.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const exports = node.exportClause;
      const onlyTypes =
        node.isTypeOnly ||
        (exports !== undefined &&
          ts.isNamedExports(exports) &&
          exports.elements.length > 0 &&
          exports.elements.every((e) => e.isTypeOnly));
      if (!onlyTypes) found.push(node.moduleSpecifier.text);
    }
  }
  return found.filter((s) => s.startsWith("."));
}

describe("the loader rule", () => {
  it("finds the adapter modules (a guard against this test checking nothing)", () => {
    const names = adapterModules.map((f) => relative(adaptersDir, f).replaceAll(sep, "/"));
    for (const expected of ["wordpress.ts", "webflow.ts", "sanity.ts", "sitemap-feed.ts"])
      expect(names).toContain(expected);
    expect(names).not.toContain("registry.ts");
  });

  it("no file outside adapters/<id>*.ts imports an adapter module except by a loader", () => {
    const offenders: string[] = [];
    const files = readdirSync(packagesDir).flatMap((pkg) => {
      const dir = join(packagesDir, pkg, "src");
      try {
        return sourceFiles(dir);
      } catch {
        return [];
      }
    });
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      if (adapterModules.includes(file)) continue;
      for (const spec of staticImports(file)) {
        const target = resolve(join(file, ".."), spec.replace(/\.js$/, ".ts"));
        if (adapterModules.includes(target)) {
          offenders.push(`${relative(packagesDir, file)} imports ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("registry.ts loads every built adapter with a dynamic import, in a loader", () => {
    const text = readFileSync(join(adaptersDir, "registry.ts"), "utf8");
    for (const module of ["sanity", "sitemap-feed", "wix", "wordpress", "webflow", "framer"])
      expect(text, module).toContain(`await import("./${module}.js")`);
    expect(text).toContain('await import("./builders.js")');
  });
});

describe("the registry's metadata", () => {
  it("every built adapter has its description without being loaded, and says the same once loaded", async () => {
    const fetcher = createFetcher({ transport: () => Promise.reject(new Error("no request")) });
    for (const [id, built] of BUILT_ADAPTERS) {
      expect(built.id).toBe(id);
      expect(typeof built.load).toBe("function");
      expect(built.describe.name.length).toBeGreaterThan(0);
      const adapter = (await built.load())({ env: {}, fetcher, site: "https://marlow.example" });
      expect(adapter.id).toBe(id);
      // The static metadata and the adapter's own description are one thing: the run header reads either.
      expect(adapter.describe()).toEqual(built.describe);
    }
  });
});

describe("loading on use", () => {
  afterEach(() => {
    vi.resetModules();
  });

  /** A fresh registry, so what an earlier test loaded does not count. */
  async function fresh() {
    vi.resetModules();
    const registry = await import("../registry.js");
    const loaded: string[] = [];
    registry.onAdapterLoad((id) => loaded.push(id));
    const fetcher = createFetcher({ transport: () => Promise.reject(new Error("no request")) });
    return { registry, loaded, fetcher };
  }

  it("naming, describing and resolving adapters loads none", async () => {
    const { registry, loaded } = await fresh();
    const config = adaptersConfigSchema.parse({
      adapters: [{ id: "wordpress" }, { id: "webflow" }, { id: "squarespace" }],
    });
    const built = registry.resolveAdapters(config);
    expect(built.map((b) => b.describe.name)).toEqual(["WordPress", "Webflow", "Squarespace"]);
    expect(() => registry.resolveAdapters({ adapters: [{ id: "nope" }] })).toThrow();
    expect(loaded).toEqual([]);
  });

  it("a WordPress-only run loads WordPress and no other adapter", async () => {
    const { registry, loaded, fetcher } = await fresh();
    const config = adaptersConfigSchema.parse({ adapters: [{ id: "wordpress" }] });
    const adapters = await registry.createAdapters(config, {
      env: { WORDPRESS_URL: "https://harbour-bar.example" },
      fetcher,
    });
    expect(adapters.map((a) => a.id)).toEqual(["wordpress"]);
    expect(loaded).toEqual(["wordpress"]);
  });

  it("a Webflow-only run loads Webflow and not WordPress, and each loads once", async () => {
    const { registry, loaded, fetcher } = await fresh();
    const webflow = adaptersConfigSchema.parse({ adapters: [{ id: "webflow" }] });
    await registry.createAdapters(webflow, { env: {}, fetcher });
    await registry.createAdapters(webflow, { env: {}, fetcher });
    expect(loaded).toEqual(["webflow"]);
    await registry.createAdapters(adaptersConfigSchema.parse({ adapters: [{ id: "wordpress" }] }), {
      env: {},
      fetcher,
    });
    expect(loaded).toEqual(["webflow", "wordpress"]);
  });

  it("with no settings file the default sitemap and feed adapter is the only one loaded", async () => {
    const { registry, loaded, fetcher } = await fresh();
    const adapters = await registry.adaptersOrDefault(undefined, {
      env: {},
      fetcher,
      site: "https://marlow.example",
    });
    expect(adapters.map((a) => a.id)).toEqual(["sitemap-feed"]);
    expect(loaded).toEqual(["sitemap-feed"]);
  });

  it("a run with no site and no settings loads nothing", async () => {
    const { registry, loaded, fetcher } = await fresh();
    expect(await registry.adaptersOrDefault(undefined, { env: {}, fetcher })).toEqual([]);
    expect(loaded).toEqual([]);
  });

  it("a listener can be removed", async () => {
    const { registry, fetcher } = await fresh();
    const seen: string[] = [];
    const stop = registry.onAdapterLoad((id) => seen.push(id));
    stop();
    await registry.createAdapters(adaptersConfigSchema.parse({ adapters: [{ id: "wix" }] }), {
      env: {},
      fetcher,
    });
    expect(seen).toEqual([]);
  });
});
