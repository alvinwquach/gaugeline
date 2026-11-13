import { CheckRegistry, defineCheck, type Finding, type Size } from "../model.js";
import { BUILT_CHECK_IDS, BUILT_TITLES, type BuiltResult } from "./built.js";
import {
  REDIRECT_CHECK_IDS,
  REDIRECT_TITLES,
  redirectConflicts,
  type RedirectCheckId,
  type RedirectResult,
} from "./redirects.js";
import type { CoverageResult } from "./coverage.js";
import type { LegacyMention } from "./legacy-notes.js";
import { NAV_TITLES, type NavCheckId, type NavResult } from "./nav.js";
import type { Plan } from "./read.js";
import { SELF_RULES, runSelfRule, type SelfRule } from "./self.js";
import { checkSlugs } from "./slug.js";
import { checkKeywords } from "./keywords.js";

/** What each check of a table says about itself: the same fields defineCheck reads. */
interface CheckText {
  what: string;
  why: string;
  fix: string;
  tech: string;
  size: Size;
  done: string;
  estimateChanges: string;
}

/** The same, for a table whose checks differ in severity. */
interface CheckTextAt extends CheckText {
  severity: Finding["severity"];
}

/** What a plan check reads: the plan, what was read out of its notes, and the file's name. */
export interface PlanCheckInput {
  plan: Plan;
  legacy: readonly LegacyMention[];
  file: string;
  /** What checkBuilt found on --base; absent when there is no --base (those checks are skipped). */
  built?: BuiltResult;
  /** What checkRedirects found on --base; absent without --base (those checks are skipped). */
  redirects?: RedirectResult;
  /** What checkCoverage found against --live; absent without --live (the check is skipped). */
  coverage?: CoverageResult;
  /** plan-rank-unknown-address, worked out with --rank; absent without it (the check is skipped). */
  rankUnknown?: readonly Finding[];
  /** What checkNav found with --nav; absent without it (the three checks are skipped). */
  nav?: NavResult;
}

const WHY: Record<string, string> = {
  "no-path": "names the old page in words, not its address",
  unconfirmed: "asks whether to redirect",
};

export const planLegacyUnresolved = defineCheck<PlanCheckInput>({
  id: "plan-legacy-unresolved",
  size: "S",
  done: "Each old address in the notes is written as a path or decided, and the plan check passes.",
  estimateChanges: "Someone who knows the old site has to say what each note means.",
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

const TEXT: Record<SelfRule["id"], CheckText> = {
  "plan-duplicate-address": {
    size: "S",
    done: "Each planned page has its own address.",
    estimateChanges: "Deciding which of two competing rows is the real page.",
    what: "Two or more rows of the plan give the same address (path and #section), so only one of those pages can exist.",
    why: "The pages compete for one address: one gets built, the other is lost, and whichever wins gets the wrong title, heading and redirects.",
    fix: "Give each planned page its own address, or merge the rows into one page.",
    tech: "Rows grouped by host without www. and path in lower case, no trailing slash or query, plus #fragment when there is one; an anchor row and its page row differ by the fragment. One finding per group, with every line",
  },
  "plan-duplicate-title": {
    size: "S",
    done: "Each planned page has a title that says what is different about it.",
    estimateChanges: "Writing good titles takes time per page.",
    what: "Two or more rows of the plan plan the same title tag.",
    why: "Search engines show the title in results; two pages with one title compete with each other and neither looks like the answer.",
    fix: "Write a title that says what is different about each page.",
    tech: "Title Tag cells compared trimmed, whitespace collapsed, lower case, with curly quotes and dashes straightened; a brand suffix is part of the title. Empty cells are left out",
  },
  "plan-duplicate-h1": {
    size: "S",
    done: "Each planned page has a heading that names its own topic.",
    estimateChanges: "Writing good headings takes time per page.",
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
  size: "S",
  done: "The slug uses the heading's spelling.",
  estimateChanges:
    "Easy before the page is built. After it is linked or indexed it also needs a redirect.",
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
  size: "M",
  done: "Each page has its own primary keyword, or the competing pages are merged.",
  estimateChanges: "Merging pages means content and redirect work.",
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
  size: "S",
  done: "The supporting pages link to the primary page and none is built to rank for its term.",
  estimateChanges: "Content edits on each supporting page.",
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

const BUILT_TEXT: Record<(typeof BUILT_CHECK_IDS)[number], CheckTextAt> = {
  "plan-404": {
    size: "M",
    done: "Each planned page loads on the preview, or its row is taken out of the plan.",
    estimateChanges:
      "A dropped page is a plan edit. A page that was never built is the full cost of building it.",
    severity: "high",
    what: "A page the plan lists returns 404 (or 410) on the preview given with --base.",
    why: "A planned page that doesn't exist at cutover loses every visitor and link meant for it.",
    fix: "Build the page, or take the row out of the plan if it was dropped.",
    tech: "Each planned path on --base fetched once with GET; 404 or 410 on the final hop. One finding per path, with every row on it",
  },
  "plan-title-drift": {
    size: "S",
    done: "Each page's title equals the plan's, or the plan is updated.",
    estimateChanges: "Pages edited by several people need the change in one place.",
    severity: "medium",
    what: "The title tag the preview sends isn't the one the plan gives the page.",
    why: "Someone edited the page, or the template overrode it, and the title the plan chose for search is gone.",
    fix: "Set the page's title to the plan's, or update the plan if the change was deliberate.",
    tech: "The page row's Title Tag against the HTML title, compared trimmed, case-folded, whitespace collapsed, quotes and dashes straightened; a brand suffix counts. No title in the HTML is reported with a hint that it may be set by JavaScript",
  },
  "plan-h1-drift": {
    size: "S",
    done: "Each page's H1 equals the plan's, or the plan is updated.",
    estimateChanges: "Deciding which side is right comes first.",
    severity: "medium",
    what: "The page's first H1 isn't the one the plan gives it.",
    why: "Usually a content change nobody recorded; the heading the plan chose for the keyword is gone.",
    fix: "Set the H1 to the plan's, or update the plan.",
    tech: "The page row's H1 against the first h1 in the HTML, compared like titles; a page with several H1s is noted",
  },
  "plan-canonical-elsewhere": {
    size: "S",
    done: "Each page's canonical is its own planned address on production.",
    estimateChanges: "A canonical that comes from one template is a single edit.",
    severity: "high",
    what: "The page's canonical names another address, often the legacy one, instead of the planned page.",
    why: "Search engines index the canonical: the new page won't be listed, the old address will.",
    fix: "Point the canonical at the page's own planned address on production.",
    tech: "The canonical's path (lower case, no trailing slash) against the row's path, on the preview's host or the plan's production host, with or without www",
  },
  "plan-anchor-missing": {
    size: "S",
    done: "Each planned #section has an element with that id on the page.",
    estimateChanges: "A section that was never built is the full cost of building it.",
    severity: "medium",
    what: "A plan row with a #section points at an id that isn't on the page.",
    why: "Links to the section land at the top of the page, and the plan's section was never built.",
    fix: "Add the section with that id, or change the row to the id the page uses.",
    tech: "The row's fragment against every element id in the HTML the preview sends",
  },
  "plan-moved-not-indexable": {
    size: "S",
    done: "Each moved page can be indexed: no noindex in the page or its headers, and no robots.txt rule that blocks it.",
    estimateChanges:
      "A noindex left from the staging site is one setting; a robots.txt copied from staging is one file.",
    severity: "high",
    what: "A page that replaces an old address (a row with a Legacy URL) is set not to be indexed: a robots meta tag or X-Robots-Tag header says noindex, or robots.txt blocks its path for Googlebot.",
    why: "The old address now redirects to a page that search engines are told to leave out, so the ranking the redirect was meant to move has nowhere to go and the page drops out of results.",
    fix: "Remove the noindex (or the robots.txt rule) from the moved pages when the site goes live. Staging settings are usually the cause.",
    tech: "Plan rows with a Legacy URL whose path differs from the row's. The page already fetched on --base: robots meta content and X-Robots-Tag containing noindex or none (a bot-named directive such as googlebot: noindex counts); one GET of /robots.txt on --base, only when a page has moved, and the longest matching rule for Googlebot (Allow wins a tie). When every page read, two or more, is set that way it is the preview's own switch: those rows are could-not-check, never a finding. The canonical of a moved page is judged by plan-canonical-elsewhere",
  },
};

export const planBuiltChecks = BUILT_CHECK_IDS.map((id) =>
  defineCheck<PlanCheckInput>({
    id,
    area: "Launch day",
    title: BUILT_TITLES[id],
    ...BUILT_TEXT[id],
    run(input, ctx) {
      // A page that asked for a password: none of the five could read it.
      for (const c of input.built?.couldNotCheck ?? []) ctx.couldNotCheck?.(c.url, c.reason);
      return (input.built?.findings ?? []).filter((f) => f.checkId === id);
    },
  }),
);

const REDIRECT_TEXT: Record<RedirectCheckId, CheckTextAt> = {
  "plan-redirect-missing": {
    size: "S",
    done: "Each old address answers with a 301 to the page its plan row names.",
    estimateChanges:
      "Many legacy addresses are one redirect file or rule, within the host's limits. The count of addresses matters less than the host.",
    severity: "high",
    what: "An old address in the plan's Legacy URL column still answers 200 or 404 on the preview instead of redirecting.",
    why: "The old address's rankings and links go nowhere: a 404 loses them, a page left in place competes with the new one.",
    fix: "Add a 301 from the old address to the row's new one. A meta refresh or JavaScript redirect isn't one.",
    tech: "The legacy address (its path and query, moved onto --base) fetched with GET; the first hop isn't a 3xx. A 200 with a meta refresh or a location assignment is reported with that hint",
  },
  "plan-redirect-not-301": {
    size: "S",
    done: "Each old address redirects with a 301, or a 308 to the right place.",
    estimateChanges:
      "A host setting that defaults to a temporary redirect fixes all of them at once.",
    severity: "high",
    what: "An old address redirects with 302, 303 or 307, or with 308 to the wrong place.",
    why: "A temporary redirect tells search engines the old address is coming back, so its rankings may not move to the new page.",
    fix: "Make it a 301. A 308 is permanent too and is accepted when it goes to the right place.",
    tech: "The status of the first hop. 308 to the planned page is accepted, with a note on stderr",
  },
  "plan-redirect-wrong-destination": {
    size: "S",
    done: "Each old address lands on the page its plan row names.",
    estimateChanges: "Overlapping rules mean testing each address after the change.",
    severity: "high",
    what: "An old address redirects, but not to the page the plan says it should.",
    why: "The old address's visitors and rankings land on the wrong page, and the planned page starts from nothing.",
    fix: "Point the redirect at the row's URL. Right path on www instead of the bare host (or the reverse) costs another hop.",
    tech: "The trail's final address (or where the last hop points, when it leaves the preview): its path against the row's, on the preview's host or exactly the plan's",
  },
  "plan-redirect-chain": {
    size: "S",
    done: "Each old address redirects once, straight to the final page.",
    estimateChanges: "Rules in the host and in the app each need checking.",
    severity: "medium",
    what: "An old address takes two or more redirects to reach its page.",
    why: "Each hop costs visitors time, and search engines follow only so many before giving up on passing signals.",
    fix: "Redirect the old address straight to the final page. A server that adds a trailing slash first counts: redirect the old address's own form.",
    tech: "More than one 3xx in the hop list the fetcher records; the trail is in the evidence",
  },
  "plan-redirect-drops-query": {
    size: "S",
    done: "The redirect passes the query string on.",
    estimateChanges: "One rule is one edit. Several rules each need it.",
    severity: "low",
    what: "An old address with a query string redirects to an address without it.",
    why: "Campaign tags and filters on old links are lost, so their visits can't be told apart.",
    fix: "Pass the query string on in the redirect rule.",
    tech: "The legacy address has a query; the trail's final address has none",
  },
  "plan-redirect-conflict": {
    size: "S",
    done: "Each old address appears in one plan row only.",
    estimateChanges: "Someone who owns the plan has to decide which page wins.",
    severity: "high",
    what: "One old address is the Legacy URL of two rows that plan different pages.",
    why: "An address can redirect to one place only: one of the two rows won't get its traffic, and no crawl will show it.",
    fix: "Decide which page the old address goes to and remove it from the other row.",
    tech: "Legacy URL cells split on line breaks and commas, keyed by path and query (lower case, no trailing slash); two rows with different addresses on one key. Needs no --base",
  },
};

export const planRedirectChecks = REDIRECT_CHECK_IDS.map((id) =>
  defineCheck<PlanCheckInput>({
    id,
    area: "Launch day",
    title: REDIRECT_TITLES[id],
    ...REDIRECT_TEXT[id],
    run(input, ctx) {
      for (const c of input.redirects?.couldNotCheck ?? []) ctx.couldNotCheck?.(c.url, c.reason);
      return (input.redirects?.findings ?? []).filter((f) => f.checkId === id);
    },
  }),
);

export const planRedirectConflict = defineCheck<PlanCheckInput>({
  id: "plan-redirect-conflict",
  area: "Launch day",
  title: REDIRECT_TITLES["plan-redirect-conflict"],
  ...REDIRECT_TEXT["plan-redirect-conflict"],
  run(input) {
    return redirectConflicts(input.plan.rows, input.file);
  },
});

export const planUncoveredPage = defineCheck<PlanCheckInput>({
  id: "plan-uncovered-page",
  size: "S",
  done: "Every live page has a row in the plan, or is named as the legacy address of its replacement.",
  estimateChanges:
    "Many pages are a spreadsheet job. Deciding what replaces each page is the real work.",
  area: "Launch day",
  severity: "high",
  title: "A page that exists today has no row in the plan",
  what: "An address in the --live export (a crawl, a sitemap, a Search Console export or a list) has no row in the plan and no Legacy URL pointing at it.",
  why: "A page that ranks today and has nowhere to go at launch loses its traffic and links: the most expensive thing on a migration.",
  fix: "Add a row for the page, or put its address in the Legacy URL of the row that replaces it.",
  tech: "Live paths (lower case, no trailing slash, no query) against a Set of every row path and legacy path; assets, feeds, ?page= and --ignore globs left out. Sorted by clicks, impressions or position when the export has them. Three or more that differ from planned rows only by a leading prefix are one finding",
  run(input) {
    return [...(input.coverage?.findings ?? [])];
  },
});

export const planRankUnknownAddress = defineCheck<PlanCheckInput>({
  id: "plan-rank-unknown-address",
  size: "S",
  done: "The rank export is of this site and recent, or the missing pages are added to --live.",
  estimateChanges: "Getting a fresh export from the search tool.",
  area: "Launch day",
  severity: "low",
  title: "Addresses in the rank export are neither live nor planned",
  what: "Pages in the --rank export (Search Console or a rank tracker) are neither in the --live list nor in the plan.",
  why: "Usually the export is of another site or property, or of pages already gone: the numbers on the uncovered list may not be the site's.",
  fix: "Check the export is of this site's property and recent, or add the pages to --live if they still exist.",
  tech: "Export paths (the --live key: lower case, no trailing slash, no query or host) not in the set of live paths or row paths. One finding with the count and three examples",
  run(input) {
    return [...(input.rankUnknown ?? [])];
  },
});

export const NAV_CHECK_IDS: readonly NavCheckId[] = [
  "plan-nav-missing-row",
  "plan-nav-label-mismatch",
  "plan-nav-needs-page",
];

const NAV_TEXT: Record<NavCheckId, CheckTextAt> = {
  "plan-nav-missing-row": {
    size: "S",
    done: "Every menu item has a row in the plan, or has been renamed to match one.",
    estimateChanges: "Several items from one restructure share one decision.",
    severity: "high",
    what: "An item in a menu tab of the plan workbook has no page row in the page plan, and no page shares a distinctive word with it (or several do).",
    why: "The menu will link to a page nobody planned: it gets built late, without a title or keyword, or the link goes nowhere.",
    fix: "Add a row for the page, or rename the menu item to the page it means. A menu heading with no page of its own can have a row with no URL.",
    tech: "Menu labels against Page and H1 cells by labelKey (G16's textKey, & as and, a trailing note such as (anchor) dropped). Headings (the first column) may match a row with no URL and are reported at medium. With several candidates, up to three are named",
  },
  "plan-nav-label-mismatch": {
    size: "S",
    done: "The menu item and the page use one name.",
    estimateChanges: "A name that is on purpose different is recorded rather than changed.",
    severity: "medium",
    what: "A menu item matches no page by name, and exactly one page shares a distinctive word with it.",
    why: "The menu and the page plan disagree on the name, so the page's title, H1 and keyword may not be what visitors click.",
    fix: "Use one name in both places, or record the difference on purpose.",
    tech: "Distinctive words are five letters or more, not health, healthcare, medical, service(s) or management. Exactly one page name with one of them; the evidence gives both labels and both lines",
  },
  "plan-nav-needs-page": {
    size: "M",
    done: "The page is built before launch, or the menu item is left out until it exists.",
    estimateChanges: "A page that is not written yet is the real cost.",
    severity: "medium",
    what: "A menu item matches a page row whose Status says Need Page.",
    why: "The menu will link to a page that hasn't been built: at launch it is a 404 in the navigation.",
    fix: "Build the page before launch, or leave the item out of the menu until it exists.",
    tech: "The matched row's Status cell against /need(s) page/i. Skipped, with a note, when the plan has no Status column",
  },
};

export const planNavChecks = NAV_CHECK_IDS.map((id) =>
  defineCheck<PlanCheckInput>({
    id,
    area: "Launch day",
    title: NAV_TITLES[id],
    ...NAV_TEXT[id],
    run(input) {
      return (input.nav?.findings ?? []).filter((f) => f.checkId === id);
    },
  }),
);

/** The plan checks, apart from the page checks: they read a plan, not a page. */
export const PLAN_CHECKS = [
  ...planBuiltChecks,
  ...planRedirectChecks,
  planRedirectConflict,
  planUncoveredPage,
  planRankUnknownAddress,
  ...planNavChecks,
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
