import { CheckRegistry, defineCheck } from "../model.js";
import type { LegacyMention } from "./legacy-notes.js";
import type { Plan } from "./read.js";
import { SELF_RULES, runSelfRule, type SelfRule } from "./self.js";
import { checkSlugs } from "./slug.js";
import { checkKeywords } from "./keywords.js";

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
        group: {
          key: open[0]?.column ?? "",
          lines: [...new Set(open.map((m) => m.line))].sort((a, b) => a - b),
        },
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

export const planSlugMisspelling = defineCheck<PlanCheckInput>({
  id: "plan-slug-misspelling",
  area: "Launch day",
  severity: "medium",
  title: "A slug misspells its own heading",
  what: "A word in a page's address is one or two letters away from a word in the same row's page name or H1, such as credentialling for Credentialing.",
  why: "The address is permanent once it is indexed and linked; fixing a typo later means a redirect, and until then the page looks careless in results.",
  fix: "Use the heading's spelling in the slug (the corrected path is in the evidence) before the page is built.",
  tech: "Words of 5+ letters in the last path segment, not in the row's page name or H1, within Damerau distance 1 of a heading word (2 for words of 8+ letters). Plural and tense endings (s, es, ed, ing) and listed British/American pairs are excused; accents are folded. One finding per row",
  run(input) {
    return checkSlugs(input.plan.rows, input.file);
  },
});

export const planKeywordCannibalisation = defineCheck<PlanCheckInput>({
  id: "plan-keyword-cannibalisation",
  area: "Launch day",
  severity: "medium",
  title: "Two pages in the plan target the same primary keyword",
  what: "Two or more pages of the plan have the same Primary Keyword, so they will compete for one search before a line of code is written.",
  why: "Search engines show one page per query from a site; two pages chasing the same term split their links and usually both rank worse than one would.",
  fix: "Give each page its own primary keyword, or merge the pages into one.",
  tech: "Primary Keyword cells compared trimmed, lower case, spaces collapsed, quotes straightened and a trailing full stop removed; no stemming (singular and plural differ). Empty, n/a, none, tbd, - and bracketed placeholders are left out. A page and its anchor rows count once. Groups sorted by a Primary Volume column when there is one",
  run(input) {
    return checkKeywords(input.plan.rows, input.file).filter((f) => f.checkId === this.id);
  },
});

export const planKeywordOverlap = defineCheck<PlanCheckInput>({
  id: "plan-keyword-overlap",
  area: "Launch day",
  severity: "low",
  title: "One page's primary keyword is another page's secondary",
  what: "A page's Primary Keyword is also listed as a Secondary Keyword of other pages.",
  why: "Often deliberate, supporting pages in a cluster; worth a look, because a strong supporting page can outrank the page meant to win the term.",
  fix: "Check the supporting pages link to the primary page, and that none of them is built to rank for the term itself.",
  tech: "Each Secondary Keyword cell is split on commas, semicolons and line breaks and compared like primaries. Reported from the primary's side, only when one page has the term as its primary",
  run(input) {
    return checkKeywords(input.plan.rows, input.file).filter((f) => f.checkId === this.id);
  },
});

/** The plan checks, apart from the page checks: they read a plan, not a page. */
export const PLAN_CHECKS = [
  ...planSelfChecks,
  planSlugMisspelling,
  planKeywordCannibalisation,
  planKeywordOverlap,
  planLegacyUnresolved,
] as const;

export function createPlanRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of PLAN_CHECKS) registry.register(c);
  return registry;
}
