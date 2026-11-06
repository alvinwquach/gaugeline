import { CheckRegistry, defineCheck } from "../model.js";
import type { LegacyMention } from "./legacy-notes.js";
import type { Plan } from "./read.js";
import { SELF_RULES, runSelfRule, type SelfRule } from "./self.js";

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

const TEXT: Record<SelfRule["id"], { what: string; why: string; fix: string; tech: string }> = {
  "plan-duplicate-address": {
    what: "Two or more rows of the plan give the same address (path and #section), so only one of those pages can exist.",
    why: "The pages compete for one address: one gets built, the other is lost, and whichever wins gets the wrong title, heading and redirects.",
    fix: "Give each planned page its own address, or merge the rows into one page.",
    tech: "Rows grouped by host without www. and path in lower case, no trailing slash or query, plus #fragment when there is one; an anchor row and its page row differ by the fragment. One finding per group, with every line",
  },
  "plan-duplicate-title": {
    what: "Two or more rows of the plan plan the same title tag.",
    why: "Search engines show the title in results; two pages with one title compete with each other and neither looks like the answer.",
    fix: "Write a title that says what is different about each page.",
    tech: "Title Tag cells compared trimmed, whitespace collapsed, lower case, with curly quotes and dashes straightened; a brand suffix is part of the title. Empty cells are left out",
  },
  "plan-duplicate-h1": {
    what: "Two or more rows of the plan plan the same H1.",
    why: "The H1 tells visitors and search engines what the page is about; two pages with the same heading read as the same page.",
    fix: "Give each page a heading that names its own topic.",
    tech: "H1 cells compared the same way as titles. Empty cells are left out",
  },
};

export const planSelfChecks = SELF_RULES.map((rule) =>
  defineCheck<PlanCheckInput>({
    id: rule.id,
    area: "Launch day",
    severity: rule.severity,
    title: rule.title,
    ...TEXT[rule.id],
    run(input) {
      return runSelfRule(rule, input.plan.rows, input.file);
    },
  }),
);

/** The plan checks, apart from the page checks: they read a plan, not a page. */
export const PLAN_CHECKS = [...planSelfChecks, planLegacyUnresolved] as const;

export function createPlanRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of PLAN_CHECKS) registry.register(c);
  return registry;
}
