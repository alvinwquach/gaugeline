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
  scripts: 15,
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
  | "scripts"
  | "structuredDataAddresses";

/** Report order. */
export const BUDGET_KINDS = [
  "links",
  "images",
  "sitemapPages",
  "feeds",
  "llmsTxtLinks",
  "scripts",
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
  scripts: ["JavaScript file", "JavaScript files"],
  structuredDataAddresses: ["address in structured data", "addresses in structured data"],
};

/**
 * "Checked 24 of 61 links, 20 of 34 images, 25 of 310 sitemap pages." Only kinds with something
 * found appear; a full sample reads "all 24 links". Returns "" when nothing was found.
 */
export function formatSampleSummary(summary: BudgetSummary): string {
  const parts: string[] = [];
  for (const kind of BUDGET_KINDS) {
    const { sampled, found } = summary[kind];
    if (found === 0) continue;
    const [one, many] = NOUNS[kind];
    if (sampled === found) parts.push(found === 1 ? `1 ${one}` : `all ${found} ${many}`);
    else parts.push(`${sampled} of ${found} ${found === 1 ? one : many}`);
  }
  return parts.length === 0 ? "" : `Checked ${parts.join(", ")}.`;
}
