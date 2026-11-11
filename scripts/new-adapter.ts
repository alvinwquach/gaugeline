/**
 * Scaffold a native adapter for a content system: new files only, then the generated index (the same code as
 * `pnpm gen:adapters`), so nothing shared is edited by hand.
 *   pnpm new:adapter <id> [--name "<Name>"] [--read rest|graphql|live-site] [--key read-only|scoped|full-access|none]
 *
 * --read  how the platform is read: rest (a documented REST API), graphql (queries only) or live-site
 *         (the site's own sitemap, for a platform with no read API or whose key can also write).
 * --key   the narrowest key the platform offers. full-access (a key that can write) means live-site.
 */
import { parseArgs } from "node:util";
import type * as Prettier from "prettier";
import { join } from "node:path";
import { findRoot } from "./lib/new-check.js";
import { generateAdapters } from "./lib/gen-adapters.js";
import {
  adapterPlaces,
  applyAdapterPlan,
  planNewAdapter,
  readAdapterState,
  type AdapterPlan,
} from "./lib/new-adapter.js";

/** The generated files, formatted the way the repository's prettier config formats the rest. */
async function formatted(plan: AdapterPlan, root: string): Promise<AdapterPlan> {
  let prettier: typeof Prettier | undefined;
  try {
    prettier = await import("prettier");
  } catch {
    return plan;
  }
  const out: AdapterPlan = [];
  for (const step of plan) {
    if (!/\.(ts|md)$/.test(step.path)) {
      out.push(step);
      continue;
    }
    const filepath = join(root, step.path);
    const config = (await prettier.resolveConfig(filepath)) ?? {};
    out.push({ ...step, content: await prettier.format(step.content, { ...config, filepath }) });
  }
  return out;
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      name: { type: "string" },
      read: { type: "string" },
      key: { type: "string" },
    },
  });
  const id = positionals[0] ?? "";
  if (!id) {
    throw new Error(
      'Usage: pnpm new:adapter <id> [--name "<Name>"] [--read rest|graphql|live-site] [--key read-only|scoped|full-access|none]',
    );
  }
  // pnpm runs scripts from the workspace root; INIT_CWD is where the command was typed.
  const root = findRoot(process.env.INIT_CWD || process.cwd());
  const plan = planNewAdapter(
    { id, name: values.name, read: values.read, key: values.key },
    readAdapterState(root, id),
  );
  applyAdapterPlan(await formatted(plan, root), root);
  for (const p of adapterPlaces(plan)) process.stdout.write(`${p}\n`);
  // The same code as pnpm gen:adapters: the new entry is in the generated index, the docs table and the sidebar.
  if ((await generateAdapters(root, false)) !== 0)
    throw new Error(
      "gen:adapters failed after the files were written. Fix the entry file and run `pnpm gen:adapters`.",
    );
  process.stdout.write(
    [
      "Next:",
      "  1. Fill in every TODO(new:adapter) (grep for it): the adapter, the fixture, the docs page, the changeset.",
      "     The contract suite passes with them; pnpm test fails on any left (adapters/__tests__/no-todo.test.ts).",
      "  2. Read the platform's documentation and put the date you checked on the docs page.",
      "  3. pnpm gen:adapters after any change to an entry file; pnpm surface for a new environment variable.",
      "Nothing else is edited by hand: the registry, the docs table and the sidebar are generated from the entry.",
      "",
    ].join("\n"),
  );
} catch (err) {
  process.stderr.write(`new:adapter: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
