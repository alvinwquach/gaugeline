import * as z from "zod";
import { ToolError, type ToolContext } from "../state.js";
import { findingId } from "../agent-text.js";
import { findingsForAgent, idToken } from "./shared.js";

export const compareRunsInput = {
  a: z.string().min(1).max(40).describe("The earlier run id, from run_check or plan_check."),
  b: z.string().min(1).max(40).describe("The later run id."),
};

/** New, fixed and unchanged findings by fingerprint: the same identity the baseline uses. */
export async function compareRuns(
  args: z.infer<z.ZodObject<typeof compareRunsInput>>,
  ctx: ToolContext,
) {
  const a = ctx.state.runs.get(args.a);
  const b = ctx.state.runs.get(args.b);
  const missing = [!a ? args.a : undefined, !b ? args.b : undefined].filter(Boolean);
  if (!a || !b)
    throw new ToolError(
      `No run ${missing.map((m) => idToken(String(m))).join(" or ")} in this session. A run id comes from run_check or plan_check; this server keeps the last 20.`,
    );
  const before = new Set(a.findings.map(findingId));
  const after = new Set(b.findings.map(findingId));
  const added = b.findings.filter((f) => !before.has(findingId(f)));
  const fixed = a.findings.filter((f) => !after.has(findingId(f)));
  return {
    a: { runId: a.id, url: a.url, startedAt: a.startedAt, findings: a.findings.length },
    b: { runId: b.id, url: b.url, startedAt: b.startedAt, findings: b.findings.length },
    counts: {
      new: added.length,
      fixed: fixed.length,
      unchanged: b.findings.length - added.length,
    },
    new: findingsForAgent(b, ctx.maxFindings, added),
    fixed: findingsForAgent(a, ctx.maxFindings, fixed),
  };
}
