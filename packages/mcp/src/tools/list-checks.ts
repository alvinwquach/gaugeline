import * as z from "zod";
import { AREAS, PROBING_CHECKS, createPageRegistry } from "@gaugeline/core";
import type { ToolContext } from "../state.js";

export const listChecksInput = {
  area: z.enum(AREAS).optional().describe("Only the checks in this area."),
  framework: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/i, "Use a framework or platform name such as next, astro or shopify.")
    .optional()
    .describe(
      "Only the checks for this framework or platform: ids that start with, or contain as a word, this name.",
    ),
};

export async function listChecks(
  args: z.infer<z.ZodObject<typeof listChecksInput>>,
  _ctx: ToolContext,
) {
  const fw = args.framework?.toLowerCase();
  const checks = createPageRegistry()
    .all()
    .filter((c) => args.area === undefined || c.area === args.area)
    .filter((c) => fw === undefined || c.id.startsWith(`${fw}-`) || c.id.includes(`-${fw}-`))
    .map((c) => ({
      id: c.id,
      area: c.area,
      severity: c.severity,
      title: c.title,
      size: c.size,
      probing: PROBING_CHECKS.includes(c.id),
    }));
  return { count: checks.length, checks };
}
