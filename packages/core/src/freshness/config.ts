import { load } from "cheerio/slim";
import * as z from "zod";
import { isTimeZone } from "../ics/time.js";
import {
  MAX_STATE_PAGES,
  SOURCE,
  parseSourceRef,
  resolveQuery,
  type QueriesOf,
} from "../switches/config.js";
import { parseTolerance } from "./decimal.js";
import { parseDuration } from "./time.js";

/** Spot checks one rule may make on a page. */
export const MAX_SPOT_CHECKS = 5;

const path = z
  .string()
  .regex(
    /^\/[^\s?#]{0,200}$/,
    'must be a path on the site like "/players/*" (no address, query or fragment)',
  );

const duration = z
  .string()
  .refine(
    (text) => parseDuration(text) !== undefined,
    'must be a length of time like "6h", "2d", "90m" or "1w" (at most 400 days)',
  );

const source = z
  .string()
  .regex(
    SOURCE,
    'must look like "db:latestSync" (a named query in gaugeline.sources.json) or "sanity:siteSettings._updatedAt"',
  );

/** A CSS selector, checked by parsing it, so a typo is a config error and not a silent miss. */
const selector = z
  .string()
  .min(1)
  .max(200)
  .refine((text) => {
    try {
      load("<p></p>")(text);
      return true;
    } catch {
      return false;
    }
  }, 'must be a CSS selector like "[data-updated]" or "time.updated"');

const attribute = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_:-]{0,40}$/,
    "must be an attribute name like datetime or data-updated",
  );
const jsonldProperty = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'must be a structured data property like "dateModified"');

const ruleId = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "must be lower-case words joined by hyphens");

const tolerance = z
  .union([z.number(), z.string()])
  .refine(
    (t) => parseTolerance(t) !== undefined,
    'must be an amount like 0.1 or a share of the source like "2%"',
  );

const stampSchema = z
  .strictObject({
    /** The element that shows when the data was updated. Its datetime or content attribute, else its text. */
    selector: selector.optional(),
    /** Read this attribute of the element instead of its datetime, content or text. */
    attr: attribute.optional(),
    /** A property of the page's structured data, like dateModified. Used when no element is found. */
    jsonld: jsonldProperty.optional(),
  })
  .refine((s) => s.selector !== undefined || s.jsonld !== undefined, {
    message: "name a selector or jsonld to read the stamp from",
  })
  .refine((s) => s.attr === undefined || s.selector !== undefined, {
    message: "attr belongs to a selector",
    path: ["attr"],
  });

const spotSchema = z.strictObject({
  /** What the figure is, in a few words, for the finding. */
  name: z.string().trim().min(1).max(60).optional(),
  selector,
  attr: attribute.optional(),
  /** Where the true figure lives: a one-row query or a Sanity field. */
  source,
  /** How far the page may be from the source: 0.1, or "2%". Default: exactly equal. */
  tolerance: tolerance.optional(),
});

const forecastSchema = z
  .strictObject({
    /** Each prediction on the page. */
    item: selector.optional(),
    /** Inside each item, the element that holds the event's date. Default: the item itself. */
    date: selector.optional(),
    /** Instead of items: the date property of the page's Event structured data. */
    jsonld: jsonldProperty.optional(),
    /** An item with this inside it already shows the result, so it is not a forecast any more. */
    settled: selector.optional(),
    /** How long an event with a start time runs. Default 3h. */
    lasts: duration.optional(),
  })
  .superRefine((f, ctx) => {
    if (f.item === undefined && f.jsonld === undefined)
      ctx.addIssue({
        code: "custom",
        message: "name item (each prediction on the page) or jsonld (the dates of its Event data)",
      });
    if (f.item !== undefined && f.jsonld !== undefined)
      ctx.addIssue({ code: "custom", message: "use item or jsonld, not both" });
    for (const key of ["date", "settled"] as const)
      if (f.item === undefined && f[key] !== undefined)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is looked for inside each item, so it needs item`,
        });
  });

const activeWhenSchema = z.strictObject({
  months: z
    .array(z.number().int().min(1).max(12))
    .min(1)
    .refine((m) => new Set(m).size === m.length, "list each month once"),
});

export const freshnessRuleSchema = z
  .strictObject({
    id: ruleId.optional(),
    /** A path on the site, or a pattern: * is one path segment, ** is any number of them. */
    page: path,
    /** Where the page shows when its data was last updated. */
    stamp: stampSchema.optional(),
    /** How old the stamp may be while the rule is active: "6h", "2d", "90m". */
    maxAge: duration.optional(),
    /** The months the data is expected to move. Outside them the rule is off. */
    activeWhen: activeWhenSchema.optional(),
    /** Where the newest sync time lives: a one-row query returning a timestamp, or a Sanity field. */
    source: source.optional(),
    /** How far behind the source the page's stamp may be. */
    maxLag: duration.optional(),
    /** Figures on the page that must match a query, within a tolerance. */
    spot: z
      .array(spotSchema)
      .min(1)
      .max(MAX_SPOT_CHECKS, `at most ${MAX_SPOT_CHECKS} spot checks per rule`)
      .optional(),
    /** Predictions on the page whose event may already be over. */
    forecast: forecastSchema.optional(),
  })
  .superRefine((r, ctx) => {
    if (!r.stamp && !r.spot && !r.forecast)
      ctx.addIssue({
        code: "custom",
        message: "name at least one of stamp, spot or forecast: what the rule looks at",
      });
    if (r.stamp && r.maxAge === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["maxAge"],
        message: 'a stamp needs maxAge, how old it may be ("6h", "2d")',
      });
    if (!r.stamp && r.maxAge !== undefined)
      ctx.addIssue({ code: "custom", path: ["stamp"], message: "maxAge needs a stamp to measure" });
    if (r.source !== undefined && r.maxLag === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["maxLag"],
        message: 'a source needs maxLag, how far behind it the page may be ("1h")',
      });
    if (r.source === undefined && r.maxLag !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "maxLag needs a source to compare the stamp with",
      });
    if (r.source !== undefined && !r.stamp)
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "a source compares the page's stamp, so the rule needs a stamp",
      });
  });

/**
 * gaugeline.freshness.json: how recent the numbers on a page should be. It holds paths, selectors,
 * durations and the names of sources, never a connection string or a key. Its `freshness` list is
 * written so it can later be one more key of gaugeline.switches.json (the rest of the shapes there
 * are the same: ids, `db:` and `sanity:` sources, paths).
 */
export const freshnessConfigSchema = z
  .strictObject({
    /** The site's own IANA time zone: for stamps that do not state one, and for the months of activeWhen. */
    timeZone: z
      .string()
      .refine(isTimeZone, 'must be an IANA time zone like "America/New_York"')
      .optional(),
    freshness: z.array(freshnessRuleSchema).min(1, "add at least one rule").max(20),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.freshness.forEach((rule, i) => {
      const name = ruleName(rule);
      if (seen.has(name))
        ctx.addIssue({
          code: "custom",
          path: ["freshness", i],
          message: `"${name}" is used by two rules; each must be different`,
        });
      seen.add(name);
    });
    const count = exactPages(config).length;
    if (count > MAX_STATE_PAGES)
      ctx.addIssue({
        code: "custom",
        message: `the file names ${count} different pages; a run reads at most ${MAX_STATE_PAGES}`,
      });
  });

export type FreshnessRule = z.infer<typeof freshnessRuleSchema>;
export type FreshnessConfig = z.infer<typeof freshnessConfigSchema>;
export type SpotCheck = z.infer<typeof spotSchema>;
export type ForecastRule = z.infer<typeof forecastSchema>;

/** A rule's name in findings and notices: its id, else the page it is about. */
export function ruleName(rule: { id?: string | undefined; page: string }): string {
  return rule.id ?? rule.page;
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

const patterns = new Map<string, RegExp>();

/**
 * Whether a page's path is the one a rule names. `*` stands for one segment of the path and `**` for
 * any number of them; a trailing slash is ignored on both sides.
 */
export function matchesPage(pattern: string, pagePath: string): boolean {
  const key = trimSlash(pattern);
  let re = patterns.get(key);
  if (!re) {
    const source = key
      .split("**")
      .map((part) =>
        part
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*"),
      )
      .join(".*");
    re = new RegExp(`^${source}$`);
    patterns.set(key, re);
  }
  return re.test(trimSlash(pagePath));
}

/** Whether a rule's page is a pattern (matched against pages the run has) and not one named page. */
export function isPattern(page: string): boolean {
  return page.includes("*");
}

/** The pages the file names outright (no pattern), once each, which the run reads itself. */
export function exactPages(config: FreshnessConfig): string[] {
  return [
    ...new Set(config.freshness.filter((r) => !isPattern(r.page)).map((r) => trimSlash(r.page))),
  ];
}

/** Every source the file names, once, in the order they first appear. */
export function freshnessSources(config: FreshnessConfig): string[] {
  const out = new Set<string>();
  for (const rule of config.freshness) {
    if (rule.source) out.add(rule.source);
    for (const s of rule.spot ?? []) out.add(s.source);
  }
  return [...out];
}

/** Whether any rule reads Sanity, so the CLI knows whether to copy its variables. */
export function usesSanity(config: FreshnessConfig): boolean {
  return freshnessSources(config).some((s) => s.startsWith("sanity:"));
}

/**
 * The problems between this file and gaugeline.sources.json: a db: source that names no query. Each
 * is a config error (exit 2) found before anything is read, not a could-not-check at the end.
 */
export function freshnessReferenceProblems(
  config: FreshnessConfig,
  sources: QueriesOf | undefined,
): string[] {
  const out: string[] = [];
  config.freshness.forEach((rule, i) => {
    const refs = [
      ...(rule.source ? [{ where: `freshness.${i}.source`, ref: rule.source }] : []),
      ...(rule.spot ?? []).map((s, j) => ({
        where: `freshness.${i}.spot.${j}.source`,
        ref: s.source,
      })),
    ];
    for (const { where, ref } of refs) {
      const parsed = parseSourceRef(ref);
      if (parsed.kind !== "db") continue;
      const found = resolveQuery(parsed, sources);
      if (!found.ok) out.push(`${where}: "${ref}": ${found.message}`);
    }
  });
  return out;
}
