import * as z from "zod";
import {
  POINTS,
  PROBING_CHECKS,
  createPageRegistry,
  createPlanRegistry,
  type Check,
} from "@gaugeline/core";
import { ToolError, type StoredRun, type ToolContext } from "../state.js";
import { findingId, findingForAgent } from "../agent-text.js";
import { idToken } from "./shared.js";

export const explainFindingInput = {
  id: z
    .string()
    .min(1)
    .max(120)
    .describe("A finding id from a run in this session, or a check id from list_checks."),
};

/** The newest run's finding with this id, searching newest first. */
export function findFinding(ctx: ToolContext, id: string) {
  for (const run of [...ctx.state.runs.values()].reverse()) {
    const finding = run.findings.find((f) => findingId(f) === id);
    if (finding) return { run, finding };
  }
  return undefined;
}

/** Gaugeline's own words about a check: fixed text, never taken from a site. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a check of any input type
export function describeCheck(c: Check<any>) {
  return {
    id: c.id,
    area: c.area,
    severity: c.severity,
    title: c.title,
    what: c.what,
    why: c.why,
    fix: c.fix,
    done: c.done,
    estimateChanges: c.estimateChanges,
    size: c.size,
    points: POINTS[c.size],
    tech: c.tech,
    probing: PROBING_CHECKS.includes(c.id),
  };
}

export function checkById(id: string, run?: StoredRun) {
  return run?.registry.get(id) ?? createPageRegistry().get(id) ?? createPlanRegistry().get(id);
}

export async function explainFinding(
  args: z.infer<z.ZodObject<typeof explainFindingInput>>,
  ctx: ToolContext,
) {
  const hit = findFinding(ctx, args.id);
  if (hit) {
    const check = checkById(hit.finding.checkId, hit.run);
    return {
      runId: hit.run.id,
      finding: findingForAgent(hit.finding, hit.run.registry),
      ...(check ? { check: describeCheck(check) } : {}),
    };
  }
  const check = checkById(args.id);
  if (check) return { check: describeCheck(check) };
  throw new ToolError(
    `No finding or check has the id ${idToken(args.id)} in this session. Run run_check first, or use an id from list_checks.`,
  );
}
