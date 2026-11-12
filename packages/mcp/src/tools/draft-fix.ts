import * as z from "zod";
import { POINTS } from "@gaugeline/core";
import { ToolError, type ToolContext } from "../state.js";
import { findingForAgent } from "../agent-text.js";
import { checkById, findFinding } from "./explain-finding.js";

export const draftFixInput = {
  findingId: z
    .string()
    .min(1)
    .max(120)
    .describe("A finding id from run_check or plan_check in this session."),
};

/**
 * A draft is text. It is built from the check's own fixed sentences (what, fix, done, tech), so no page
 * text is in it: that stays in the labelled finding beside it. Nothing here writes, commits or deploys.
 */
export async function draftFix(args: z.infer<z.ZodObject<typeof draftFixInput>>, ctx: ToolContext) {
  const hit = findFinding(ctx, args.findingId);
  if (!hit)
    throw new ToolError(
      `No finding with the id ${JSON.stringify(args.findingId.slice(0, 60))} in this session. Run run_check first.`,
    );
  const check = checkById(hit.finding.checkId, hit.run);
  if (!check)
    throw new ToolError(`The check ${hit.finding.checkId} is not available in this version.`);
  const src = hit.finding.source;
  const points = POINTS[check.size];
  const patch = [
    "# Gaugeline draft fix. NOT APPLIED: nothing was written, committed, published or changed.",
    "# A person or a coding agent applies it, then runs Gaugeline again to confirm.",
    `# Check: ${check.id} (${check.title}); size ${check.size}, ${points} point${points === 1 ? "" : "s"}.`,
    "",
    ...(src
      ? [
          "--- a/<the file named in finding.source>",
          "+++ b/<the same file>",
          `@@ line ${src.line} @@`,
          "",
        ]
      : []),
    `What is wrong: ${check.what}`,
    `Change to make: ${check.fix}`,
    `Done when: ${check.done}`,
    `Technical: ${check.tech}`,
    "",
    "# Gaugeline does not read your source, so it writes the change in words, not as a diff you could apply blind.",
  ].join("\n");
  return {
    runId: hit.run.id,
    applied: false,
    format: "text/plain",
    patch,
    finding: findingForAgent(hit.finding, hit.run.registry),
  };
}
