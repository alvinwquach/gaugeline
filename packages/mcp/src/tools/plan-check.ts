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
import { findingsForAgent, urlSchema } from "./shared.js";

const PLAN_EXTENSIONS = new Set([".csv", ".tsv", ".txt", ".xlsx"]);
const MAX_PLAN_BYTES = 5 * 1024 * 1024;

export const planCheckInput = {
  planFile: z
    .string()
    .min(1)
    .max(512)
    .describe(
      "Path of the launch plan (.csv, .tsv, .txt or .xlsx), relative to the folder the server was started with. Paths outside that folder are refused.",
    ),
  url: urlSchema.describe("The preview or built site to check the plan against (its origin)."),
};

/** The plan file, read only if it is a plan-sized file inside the server's root. */
function readPlanFile(root: string, requested: string): { name: string; bytes: Uint8Array } {
  const base = realpathSync(resolve(root));
  let real: string;
  try {
    real = realpathSync(resolve(base, requested));
  } catch {
    throw new ToolError(`${JSON.stringify(requested)} could not be read inside the plan folder.`);
  }
  const rel = relative(base, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    throw new ToolError(
      "The plan file must be inside the folder the server was started with. Nothing was read.",
    );
  if (!PLAN_EXTENSIONS.has(extname(real).toLowerCase()))
    throw new ToolError("A plan file is a .csv, .tsv, .txt or .xlsx export. Nothing was read.");
  if (!statSync(real).isFile() || statSync(real).size > MAX_PLAN_BYTES)
    throw new ToolError("The plan must be a file of at most 5 MB.");
  return { name: basename(real), bytes: readFileSync(real) };
}

export async function planCheck(
  args: z.infer<z.ZodObject<typeof planCheckInput>>,
  ctx: ToolContext,
) {
  const { name, bytes } = readPlanFile(ctx.options.root ?? process.cwd(), args.planFile);
  const plan = readPlan(bytes, { fileName: name });
  const fetcher = ctx.fetcherFor(args.url);
  const startedAt = ctx.now();
  // The same calls as `gaugeline plan --base`: each planned path with GET, each legacy address once.
  const built = await checkBuilt(plan.rows, { base: args.url, fetcher, file: name });
  const redirects = await checkRedirects(plan.rows, { base: args.url, fetcher, file: name });
  const registry = createPlanRegistry();
  const result = await runChecks({ plan, legacy: [], file: name, built, redirects }, registry, {
    skip: [...NAV_CHECK_IDS, "plan-uncovered-page", "plan-rank-unknown-address"],
  });
  const run = remember(ctx.state, {
    kind: "plan",
    url: args.url,
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
    url: args.url,
    summary: { findings: result.findings.length, couldNotCheck: result.couldNotCheck.length },
    ...findingsForAgent(run, ctx.maxFindings),
    couldNotCheck: result.couldNotCheck.map((c) => ({ id: c.id, reason: c.reason })),
  };
}
