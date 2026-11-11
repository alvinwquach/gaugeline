/**
 * How much a run samples. These numbers are published on the Running a check and Security pages,
 * so they live here and nowhere else. There are no flags to raise them: they are a promise to the
 * site being checked.
 */
export const LIMITS = Object.freeze({
  links: 30,
  images: 20,
  sitemapPages: 25,
  /** Sitemap files read (robots.txt's, /sitemap.xml, an index's children) to fill that sample. */
  sitemapFiles: 10,
  feeds: 3,
  /** Links listed in /llms.txt that are requested. */
  llmsTxtLinks: 10,
  /** App Store and Google Play apps looked up in the stores. */
  appLinks: 5,
  /** .ics calendar feeds read. */
  calendars: 3,
  /** Other same-site pages fetched for checks that compare pages (structured data rules). */
  pages: 4,
  /** Other-language versions of the checked page that are fetched. */
  languageVersions: 5,
  /** Cash App and Venmo profile links requested. */
  paymentLinks: 5,
  /** Square and Stripe payment links read (GET, nothing submitted). */
  checkoutLinks: 5,
  scripts: 15,
  /** Sanity datasets asked for their document count and type names (no token, no contents). */
  sanityDatasets: 2,
  /** Tables of the configured database project counted (HEAD, counts only). */
  accessTables: 20,
  /** Addresses in hidden sections asked for their status and robots directives. */
  hiddenPages: 5,
  /** Pages named in gaugeline.switches.json, gaugeline.freshness.json and gaugeline.model.json (the order page, the menu, the stats page, a listing and its pages of results), read with GET. */
  statePages: 16,
  /** Conventional Next.js draft and preview routes asked once each, with no secret. */
  draftRoutes: 4,
  /** Download routes asked once each with no session, 1,024 bytes read (a probing check: only with owner consent). */
  downloadRoutes: 10,
  /** Bytes read from a download route's answer before the connection is closed. */
  downloadPeekBytes: 1024,
  /** Signed-in routes asked once each with no session by check --routes (a probing check: only with owner consent). */
  routeProbes: 30,
  /** Bytes read from a route's answer to tell a sign-in form from a page, then the connection is closed. */
  routeProbeBytes: 64 * 1024,
  /** Framework addresses (/_next/, ?_rsc=) found and ignored: never requested, so the limit is 0. */
  frameworkAddresses: 0,
  /** Addresses a Nuxt check asks once each: the page's own payload file, a preview query, the dev tools route. */
  nuxtAddresses: 6,
  structuredDataAddresses: 12,
  concurrency: 5,
  redirectHops: 10,
  bodyBytes: 5 * 1024 * 1024,
} as const);

export type Limits = { readonly [K in keyof typeof LIMITS]: number };

export type BudgetKind =
  | "links"
  | "images"
  | "sitemapPages"
  | "feeds"
  | "llmsTxtLinks"
  | "appLinks"
  | "calendars"
  | "pages"
  | "languageVersions"
  | "paymentLinks"
  | "checkoutLinks"
  | "scripts"
  | "sanityDatasets"
  | "accessTables"
  | "hiddenPages"
  | "statePages"
  | "draftRoutes"
  | "downloadRoutes"
  | "frameworkAddresses"
  | "nuxtAddresses"
  | "structuredDataAddresses";

/** Report order. */
export const BUDGET_KINDS = [
  "links",
  "images",
  "sitemapPages",
  "feeds",
  "llmsTxtLinks",
  "appLinks",
  "calendars",
  "pages",
  "languageVersions",
  "paymentLinks",
  "checkoutLinks",
  "scripts",
  "sanityDatasets",
  "accessTables",
  "hiddenPages",
  "statePages",
  "draftRoutes",
  "downloadRoutes",
  "frameworkAddresses",
  "nuxtAddresses",
  "structuredDataAddresses",
] as const satisfies readonly BudgetKind[];

export interface BudgetTally {
  limit: number;
  sampled: number;
  found: number;
}

export type BudgetSummary = Record<BudgetKind, BudgetTally>;

export interface Budget {
  /**
   * Returns the first candidates that still fit the allowance, in input order, and counts every
   * candidate as found. Callers dedupe by normalised URL first; take() does not dedupe.
   */
  take<T>(kind: BudgetKind, candidates: readonly T[]): T[];
  remaining(kind: BudgetKind): number;
  summary(): BudgetSummary;
}

/** One budget per run, created by the runner and passed in the check context. */
export function createBudget(limits: Limits = LIMITS): Budget {
  const tally = {} as BudgetSummary;
  for (const kind of BUDGET_KINDS) tally[kind] = { limit: limits[kind], sampled: 0, found: 0 };
  return {
    take<T>(kind: BudgetKind, candidates: readonly T[]): T[] {
      const t = tally[kind];
      const room = Math.max(0, t.limit - t.sampled);
      const taken = candidates.slice(0, room);
      t.sampled += taken.length;
      t.found += candidates.length;
      return taken;
    },
    remaining(kind) {
      const t = tally[kind];
      return Math.max(0, t.limit - t.sampled);
    },
    summary() {
      const out = {} as BudgetSummary;
      for (const kind of BUDGET_KINDS) out[kind] = { ...tally[kind] };
      return out;
    },
  };
}

const NOUNS: Record<BudgetKind, [singular: string, plural: string]> = {
  links: ["link", "links"],
  images: ["image", "images"],
  sitemapPages: ["sitemap page", "sitemap pages"],
  feeds: ["feed", "feeds"],
  llmsTxtLinks: ["llms.txt link", "llms.txt links"],
  appLinks: ["app store link", "app store links"],
  calendars: ["calendar", "calendars"],
  pages: ["other page", "other pages"],
  languageVersions: ["language version", "language versions"],
  paymentLinks: ["payment link", "payment links"],
  checkoutLinks: ["checkout link", "checkout links"],
  scripts: ["JavaScript file", "JavaScript files"],
  sanityDatasets: ["Sanity dataset", "Sanity datasets"],
  accessTables: ["database table", "database tables"],
  hiddenPages: ["hidden page", "hidden pages"],
  statePages: ["switch page", "switch pages"],
  draftRoutes: ["draft route", "draft routes"],
  downloadRoutes: ["download route", "download routes"],
  frameworkAddresses: ["framework address", "framework addresses"],
  nuxtAddresses: ["Nuxt address", "Nuxt addresses"],
  structuredDataAddresses: ["address in structured data", "addresses in structured data"],
};

/**
 * "Checked 24 of 61 links, 20 of 34 images, 25 of 310 sitemap pages." Only kinds with something
 * found appear; a full sample reads "all 24 links". Returns "" when nothing was found.
 */
export function formatSampleSummary(summary: BudgetSummary): string {
  const parts: string[] = [];
  // Only the kinds that were cut short: "Checked 30 of 112 links, 20 of 46 images." A full sample
  // is in the report's "How much was sampled", not on the terminal.
  for (const kind of BUDGET_KINDS) {
    const { sampled, found } = summary[kind];
    if (found === 0 || sampled >= found || kind === "frameworkAddresses") continue;
    parts.push(`${sampled} of ${found} ${kindNoun(kind, found)}`);
  }
  const checked = parts.length === 0 ? "" : `Checked ${parts.join(", ")}.`;
  // Framework addresses are never requested: they are counted, not checked.
  const ignored = summary.frameworkAddresses.found;
  const note =
    ignored === 0 ? "" : `${ignored} framework address${ignored === 1 ? "" : "es"} ignored.`;
  return [checked, note].filter((s) => s !== "").join(" ");
}

/** "link" or "links", for a count of that kind. */
export function kindNoun(kind: BudgetKind, count: number): string {
  const [one, many] = NOUNS[kind];
  return count === 1 ? one : many;
}

/** How much of each kind was found and taken, for the result and --json: every kind, zeros included. */
export interface SampleCount {
  seen: number;
  taken: number;
  limit: number;
}

export function sampleCounts(summary: BudgetSummary): Record<BudgetKind, SampleCount> {
  const out = {} as Record<BudgetKind, SampleCount>;
  for (const kind of BUDGET_KINDS) {
    const { limit, sampled, found } = summary[kind];
    out[kind] = { seen: found, taken: sampled, limit };
  }
  return out;
}
