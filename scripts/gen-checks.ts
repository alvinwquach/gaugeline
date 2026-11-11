/**
 * docs/checks.data.json from the check registry, and docs/check-ids.lock.json (append-only).
 *   pnpm gen:checks           write both
 *   pnpm gen:checks --check   compare only; exit 1 when stale
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AREAS,
  BUDGET_KINDS,
  AD_LANDING_CHECKS,
  CAMPAIGN_CHECKS,
  DUPLICATE_CHECKS,
  EMAIL_CHECKS,
  PLAN_CHECKS,
  PRESENCE_CHECKS,
  PRICE_CHECKS,
  RENEWALS_CHECKS,
  HANDOFF_CHECKS,
  COST_CHECKS,
  TRACKER_CHECKS,
  PUBLISHED_CHECKS,
  LIBRARY_CHECKS,
  WORDPRESS_CHECKS,
  PRINTED_CHECKS,
  GRAPHQL_CHECKS,
  MUTATION_CHECKS,
  QUERY_CHECKS,
  QUERY_DUPE_CHECKS,
  QUERY_GENERATED_CHECKS,
  QUERY_UNUSED_CHECKS,
  RECEIPT_CHECKS,
  ROUTE_CHECKS,
  WEBHOOK_CHECKS,
  SUBSCRIPTION_CHECKS,
  CUTOVER_ONLY_CHECKS,
  MIGRATION_CHECKS,
  WEBFLOW_CHECKS,
  SHOPIFY_CHECKS,
  CONTENTFUL_CHECKS,
  SQUARESPACE_COMMERCE_CHECKS,
  STRAPI_CHECKS,
  catalogue,
  createPageRegistry,
} from "../packages/core/src/index.js";
import { kindNoun } from "../packages/core/src/limits.js";
import { format, resolveConfig } from "prettier";
import { updateLock } from "./lib/check-ids.js";
import { renderChecksTable, replaceChecksBlock } from "./lib/readme-checks.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const dataPath = process.env.GEN_CHECKS_DATA ?? `${root}docs/checks.data.json`;
const lockPath = process.env.GEN_CHECKS_LOCK ?? `${root}docs/check-ids.lock.json`;
// The app's title list. A run pointed at temp data writes it beside that data, never into the repository.
const titlesPath =
  process.env.GEN_CHECKS_APP_TITLES ??
  (process.env.GEN_CHECKS_DATA
    ? `${dirname(dataPath)}/check-titles.ts`
    : `${root}packages/app/src/check-titles.ts`);
const check = process.argv.includes("--check");
// The READMEs' check lists. A run pointed at temp data (GEN_CHECKS_DATA) leaves them alone unless asked.
const readmes = (
  process.env.GEN_CHECKS_READMES ??
  (process.env.GEN_CHECKS_DATA ? "" : `${root}README.md,${root}packages/cli/README.md`)
)
  .split(",")
  .filter((p) => p !== "");

// The reference lists the page checks and the plan checks (which read a plan file, not a page).
const registry = createPageRegistry();
for (const c of PLAN_CHECKS) registry.register(c);
for (const c of PRINTED_CHECKS) registry.register(c);
for (const c of CAMPAIGN_CHECKS) registry.register(c);
for (const c of AD_LANDING_CHECKS) registry.register(c);
for (const c of DUPLICATE_CHECKS) registry.register(c);
for (const c of EMAIL_CHECKS) registry.register(c);
for (const c of RENEWALS_CHECKS) registry.register(c);
for (const c of HANDOFF_CHECKS) registry.register(c);
for (const c of COST_CHECKS) registry.register(c);
for (const c of TRACKER_CHECKS) registry.register(c);
for (const c of PUBLISHED_CHECKS) registry.register(c);
for (const c of LIBRARY_CHECKS) registry.register(c);
for (const c of WORDPRESS_CHECKS) registry.register(c);
for (const c of PRESENCE_CHECKS) registry.register(c);
for (const c of PRICE_CHECKS) registry.register(c);
for (const c of SUBSCRIPTION_CHECKS) registry.register(c);
for (const c of QUERY_CHECKS) registry.register(c);
for (const c of QUERY_DUPE_CHECKS) registry.register(c);
for (const c of QUERY_GENERATED_CHECKS) registry.register(c);
for (const c of QUERY_UNUSED_CHECKS) registry.register(c);
for (const c of MUTATION_CHECKS) registry.register(c);
for (const c of GRAPHQL_CHECKS) registry.register(c);
for (const c of RECEIPT_CHECKS) registry.register(c);
for (const c of ROUTE_CHECKS) registry.register(c);
for (const c of WEBHOOK_CHECKS) registry.register(c);
for (const c of CUTOVER_ONLY_CHECKS) registry.register(c);
for (const c of MIGRATION_CHECKS) registry.register(c);
for (const c of WEBFLOW_CHECKS) registry.register(c);
for (const c of SHOPIFY_CHECKS) registry.register(c);
for (const c of CONTENTFUL_CHECKS) registry.register(c);
for (const c of SQUARESPACE_COMMERCE_CHECKS) registry.register(c);
for (const c of STRAPI_CHECKS) registry.register(c);
const entries = catalogue(registry);
// A scaffold from pnpm new:check imports and runs, but its TODO text must never reach the docs.
const unfinished = entries.flatMap((e) =>
  (["title", "what", "why", "fix", "tech", "done", "estimateChanges"] as const)
    .filter((f) => e[f].trim().startsWith("TODO"))
    .map((f) => `${e.id} (${f})`),
);
if (unfinished.length > 0) {
  process.stderr
    .write(`gen:checks: TODO text left in ${unfinished.join(", ")}. Write the real text before merging.
`);
  process.exit(1);
}
const data = `${JSON.stringify(entries, null, 2)}\n`;
// The app shows what passed by title, a finding's plain-English text, and the sampled kinds by noun,
// from the result's ids alone. All three are small enough to ship in the client (about 20 KB gzip),
// so it needs no route of its own for them.
// Written as escapes so the generated file is plain ASCII (a visible dash or section sign in a check's
// text is \u2013 or \u00a7 in the source, and the same character in the app).
const js = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[^ -~]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const titles = await format(
  `// Generated by pnpm gen:checks from the check registry. Do not edit by hand.
export const AREA_ORDER: readonly string[] = ${js(AREAS)};
export const CHECK_TITLES: Readonly<Record<string, readonly [title: string, area: string]>> = ${js(
    Object.fromEntries(entries.map((e) => [e.id, [e.title, e.area]])),
  )};
export const CHECK_TEXT: Readonly<Record<string, readonly [what: string, why: string, fix: string, tech: string]>> = ${js(
    Object.fromEntries(entries.map((e) => [e.id, [e.what, e.why, e.fix, e.tech]])),
  )};
export const SAMPLE_NOUNS: Readonly<Record<string, readonly [one: string, many: string]>> = ${js(
    Object.fromEntries(BUDGET_KINDS.map((k) => [k, [kindNoun(k, 1), kindNoun(k, 2)]])),
  )};
`,
  { ...((await resolveConfig(titlesPath)) ?? {}), filepath: titlesPath },
);
const lock = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, "utf8")) as string[]) : [];
const next = updateLock(
  lock,
  entries.map((e) => e.id),
);
if (!next.ok) {
  process.stderr.write(
    `gen:checks: ${next.missing.join(", ")} shipped before and is no longer registered. Check ids are a public interface: see STABILITY.md before removing one.\n`,
  );
  process.exitCode = 1;
} else {
  const lockText = `${JSON.stringify(next.lock, null, 2)}\n`;
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").replace(/\r\n/g, "\n") : "");
  const table = renderChecksTable(entries);
  // Formatted the way Prettier would, so gen:checks and format:check never disagree.
  const readmeText = await Promise.all(
    readmes.map(async (p) => ({
      p,
      next: await format(replaceChecksBlock(read(p), table, p), {
        ...((await resolveConfig(p)) ?? {}),
        filepath: p,
      }),
    })),
  );
  if (check) {
    if (read(titlesPath) !== titles) {
      process.stderr.write(
        "gen:checks: packages/app/src/check-titles.ts is stale, run pnpm gen:checks\n",
      );
      process.exitCode = 1;
    }
    if (read(dataPath) !== data || read(lockPath) !== lockText) {
      process.stderr.write("gen:checks: checks.data.json is stale, run pnpm gen:checks\n");
      process.exitCode = 1;
    }
    for (const { p, next } of readmeText) {
      if (read(p) !== next) {
        process.stderr.write(`gen:checks: the check list in ${p} is stale, run pnpm gen:checks\n`);
        process.exitCode = 1;
      }
    }
  } else {
    writeFileSync(dataPath, data);
    writeFileSync(lockPath, lockText);
    writeFileSync(titlesPath, titles);
    for (const { p, next } of readmeText) writeFileSync(p, next);
    process.stdout.write(`gen:checks: ${entries.length} checks written to docs/checks.data.json\n`);
  }
}
