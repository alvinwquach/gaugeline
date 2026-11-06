import { CheckRegistry, defineCheck } from "../model.js";
import type { LegacyMention } from "./legacy-notes.js";
import type { Plan } from "./read.js";

/** What a plan check reads: the plan, what was read out of its notes, and the file's name. */
export interface PlanCheckInput {
  plan: Plan;
  legacy: readonly LegacyMention[];
  file: string;
}

const WHY: Record<string, string> = {
  "no-path": "names the old page in words, not its address",
  unconfirmed: "asks whether to redirect",
};

export const planLegacyUnresolved = defineCheck<PlanCheckInput>({
  id: "plan-legacy-unresolved",
  area: "Launch day",
  severity: "medium",
  title: "Some old addresses in the plan's notes aren't settled",
  what: "A notes column read with --legacy-from mentions a legacy page in words instead of by its address, or asks whether it should redirect, so no redirect can be checked for it.",
  why: "Old addresses that rank keep their traffic only with a 301 to the right new page. A note nobody resolved is a redirect nobody will build.",
  fix: 'Put the old address in the note ("301 legacy /old-page here.") or decide and write it, then run the plan check again.',
  tech: 'Sentences in the --legacy-from columns containing "legacy": one that says 301 but names no path (no-path), or one with a path that starts with Confirm, contains whether or ends with a question mark (unconfirmed). One finding listing every line',
  run(input) {
    const open = input.legacy.filter((m) => m.kind === "no-path" || m.kind === "unconfirmed");
    if (open.length === 0) return [];
    const parts = open.map(
      (m) =>
        `line ${m.line} ${m.path ? `${m.path} ` : ""}(${WHY[m.kind] ?? m.kind}): "${m.sentence}"`,
    );
    return [
      {
        checkId: "plan-legacy-unresolved",
        severity: "medium",
        title: this.title,
        evidence: `${open.length} mention${open.length === 1 ? "" : "s"} in "${open[0]?.column ?? ""}": ${parts.join("; ")}`,
        url: input.file,
      },
    ];
  },
});

/** The plan checks, apart from the page checks: they read a plan, not a page. */
export const PLAN_CHECKS = [planLegacyUnresolved] as const;

export function createPlanRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of PLAN_CHECKS) registry.register(c);
  return registry;
}
