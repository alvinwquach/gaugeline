/**
 * Scaffold a new check in the six places it lives.
 *   pnpm new:check <id> --area <search|visitors|sales|leads|security|launch> --severity <high|medium|low> [--title "<title>"]
 */
import { parseArgs } from "node:util";
import { applyPlan, findRoot, places, planNewCheck, readRepoState } from "./lib/new-check.js";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: { area: { type: "string" }, severity: { type: "string" }, title: { type: "string" } },
  });
  const id = positionals[0] ?? "";
  if (!id || !values.area || !values.severity) {
    throw new Error(
      'Usage: pnpm new:check <id> --area <area> --severity <level> [--title "<title>"]',
    );
  }
  // pnpm runs scripts from the workspace root; INIT_CWD is where the command was typed.
  const root = findRoot(process.env.INIT_CWD || process.cwd());
  const candidates = [
    `packages/core/src/checks/${id}.ts`,
    `packages/core/src/checks/__tests__/${id}.test.ts`,
    `packages/fixtures/sites/${id}/index.html`,
    `packages/fixtures/sites/${id}/clean.html`,
    `packages/fixtures/sites/${id}/routes.json`,
    `.changeset/${id}.md`,
  ];
  const plan = planNewCheck(
    {
      id,
      area: values.area,
      severity: values.severity,
      ...(values.title ? { title: values.title } : {}),
    },
    readRepoState(root, candidates),
  );
  applyPlan(plan, root);
  for (const p of places(plan)) process.stdout.write(`${p}\n`);
  process.stdout.write("Next: fill in the TODO text, then pnpm gen:checks\n");
} catch (err) {
  process.stderr.write(`new:check: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
