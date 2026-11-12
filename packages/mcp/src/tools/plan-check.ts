import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import * as z from "zod";
import {
  NAV_CHECK_IDS,
  checkBuilt,
  checkRedirects,
  createPlanRegistry,
  readPlan,
  runChecks,
} from "@gaugeline/core";
import { ToolError, remember, type ToolContext } from "../state.js";
import { couldNotCheckForAgent, findingsForAgent, urlSchema } from "./shared.js";

const PLAN_EXTENSIONS = new Set([".csv", ".tsv", ".txt", ".xlsx"]);
const MAX_PLAN_BYTES = 5 * 1024 * 1024;

export const planCheckInput = {
  planFile: z
    .string()
    .min(1)
    .max(512)
    .describe(
      "Path of the launch plan (.csv, .tsv, .txt or .xlsx), relative to the plan folder the operator named with --root.",
    ),
  url: urlSchema.describe(
    "The preview or built site to check the plan against. Its origin must be one the operator allowed with --plan-base.",
  ),
};

/** One message for every way a plan file can be refused, so no answer says whether a path exists. */
const NOT_A_PLAN_FILE =
  "The plan file must be a .csv, .tsv, .txt or .xlsx file inside the plan folder the server was started with. Nothing was read or requested.";

const inside = (base: string, path: string) => {
  const rel = relative(base, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** The plan file, read only if it is a plan-sized file inside the operator's root. */
function readPlanFile(root: string, requested: string): { name: string; bytes: Uint8Array } {
  const refuse = () => new ToolError(NOT_A_PLAN_FILE);
  const base = realpathSync(resolve(root));
  // Confinement is judged on the path as written first, so an absolute or climbing path gets the same
  // answer whether or not it exists; the real path (symbolic links followed) is judged again after.
  const wanted = resolve(base, requested);
  if (!inside(base, wanted)) throw refuse();
  let real: string;
  try {
    real = realpathSync(wanted);
  } catch {
    throw refuse();
  }
  if (!inside(base, real) || !PLAN_EXTENSIONS.has(extname(real).toLowerCase())) throw refuse();
  const info = statSync(real);
  if (!info.isFile() || info.size > MAX_PLAN_BYTES) throw refuse();
  return { name: basename(real), bytes: readFileSync(real) };
}

/** The origins the operator allowed, normalised; plan_check checks a plan against none other. */
function allowedBase(ctx: ToolContext, url: string): string {
  const origin = new URL(url).origin;
  const allowed = (ctx.options.planBases ?? []).map((b) => new URL(b).origin);
  if (!allowed.includes(origin))
    throw new ToolError(
      "That address is not one this server was started to check a plan against (--plan-base). Nothing was read or requested.",
    );
  return origin;
}

export async function planCheck(
  args: z.infer<z.ZodObject<typeof planCheckInput>>,
  ctx: ToolContext,
) {
  if (!ctx.options.root || (ctx.options.planBases ?? []).length === 0)
    throw new ToolError(
      "plan_check is off: the server was started without --root and --plan-base.",
    );
  // The address first, then the file: a refused address never gets as far as reading a file.
  const base = allowedBase(ctx, args.url);
  const { name, bytes } = readPlanFile(ctx.options.root, args.planFile);
  let plan: ReturnType<typeof readPlan>;
  try {
    plan = readPlan(bytes, { fileName: name });
  } catch {
    // The reader's message quotes the file's own cells (its headers, a row): fixed text here instead.
    throw new ToolError(
      "That file could not be read as a launch plan: it needs a URL column and at least one row. Its contents are not shown.",
    );
  }
  const fetcher = ctx.fetcherFor(base);
  const startedAt = ctx.now();
  // The same calls as `gaugeline plan --base`: each planned path with GET, each legacy address once.
  const built = await checkBuilt(plan.rows, { base, fetcher, file: name });
  const redirects = await checkRedirects(plan.rows, { base, fetcher, file: name });
  const registry = createPlanRegistry();
  const result = await runChecks({ plan, legacy: [], file: name, built, redirects }, registry, {
    skip: [...NAV_CHECK_IDS, "plan-uncovered-page", "plan-rank-unknown-address"],
  });
  const run = remember(ctx.state, {
    kind: "plan",
    url: base,
    startedAt: startedAt.toISOString(),
    findings: result.findings,
    passed: result.passed,
    failed: result.failed.map((f) => f.id),
    couldNotCheck: result.couldNotCheck,
    registry,
  });
  return {
    runId: run.id,
    kind: "read",
    plan: { file: name, rows: plan.rows.length },
    url: base,
    summary: { findings: result.findings.length, couldNotCheck: result.couldNotCheck.length },
    ...findingsForAgent(run, ctx.maxFindings),
    ...couldNotCheckForAgent(result.couldNotCheck),
  };
}
