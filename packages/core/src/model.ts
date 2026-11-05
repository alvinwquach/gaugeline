import type * as z from "zod";
import type { Fetcher } from "./fetcher.js";
import type { Budget } from "./limits.js";
import type { findingSchema } from "./result.js";
import type { AppLookup } from "./apps.js";
import type { LinkSample } from "./links.js";
import type { SiteContext } from "./site-context.js";

/** Fix this first / Fix soon / Worth knowing. */
export type Severity = "high" | "medium" | "low";

export const SEVERITIES = ["high", "medium", "low"] as const satisfies readonly Severity[];

/** Sort order: high first. Severities are names, so ordering needs an explicit table. */
export const SEVERITY_ORDER: Readonly<Record<Severity, number>> = Object.freeze({
  high: 0,
  medium: 1,
  low: 2,
});

export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = Object.freeze({
  high: "Fix this first",
  medium: "Fix soon",
  low: "Worth knowing",
});

export type Area =
  "Search & sharing" | "Visitors" | "Sales & prices" | "Leads" | "Security & email" | "Launch day";

export const AREAS = [
  "Search & sharing",
  "Visitors",
  "Sales & prices",
  "Leads",
  "Security & email",
  "Launch day",
] as const satisfies readonly Area[];

/**
 * One thing found on a site. The shape is defined once, as a zod schema in result.ts, and this
 * type is inferred from it so the type, the runtime validator and the published JSON Schema agree.
 *
 * - checkId: stable, kebab-case, e.g. "canonical-elsewhere"
 * - title: plain English, for whoever owns the site
 * - evidence: the grey technical line, for whoever fixes it
 * - url: the address the evidence is about
 * - source: for repository checks
 */
export type Finding = z.infer<typeof findingSchema>;

/** Effort to fix, used by the work order (G28). */
export type Size = "S" | "M" | "L";

/** Passed to every check. Later branches add the fetcher, the budget and the run's options. */
/** What the person running the check says should be true, for checks that compare against it. */
export interface RunExpectations {
  /** The app's name as it should appear in the App Store and on Google Play. */
  appName?: string;
}

export interface CheckContext {
  /** Notes for developers (a check returned undefined, for example). Never printed to stdout by core. */
  warn(message: string): void;
  /** The run's sampling allowance. Every sampler draws from this one counter. */
  budget?: Budget;
  /** The run's fetcher, for checks that need a second request (host-duplicate). */
  fetcher?: Fetcher;
  /**
   * robots.txt, the sitemaps and the feeds, read once per run on first use and shared by every
   * check. Absent when the run has no site to read (a unit test, a single-page check).
   */
  site?: () => Promise<SiteContext>;
  /** The run's same-site link sample, probed once on first use and shared by the link checks. */
  links?: () => Promise<LinkSample>;
  /** The page's App Store and Google Play apps, looked up once on first use. */
  apps?: () => Promise<AppLookup[]>;
  /** Values the run was told to expect (for example the app's name). Until the config file, API only. */
  expect?: RunExpectations;
}

export interface Check<Input> {
  id: string;
  area: Area;
  severity: Severity;
  title: string;
  what: string;
  why: string;
  fix: string;
  /** The technical line in the checks reference, for whoever fixes it. */
  tech: string;
  /** Effort to fix (G28). */
  size?: Size;
  /** What fixed looks like (G28). */
  done?: string;
  run(input: Input, ctx: CheckContext): Finding[] | Promise<Finding[]>;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isKebabCase(id: string): boolean {
  return KEBAB.test(id);
}

/** Validates the id and freezes the check so a caller cannot change it after registration. */
export function defineCheck<I>(c: Check<I>): Check<I> {
  if (!isKebabCase(c.id)) {
    throw new TypeError(
      `Check id "${c.id}" must be kebab-case, for example "canonical-elsewhere".`,
    );
  }
  // The checks reference prints these four lines for every check, so none may be empty.
  for (const field of ["what", "why", "fix", "tech"] as const) {
    if (typeof c[field] !== "string" || c[field].trim() === "") {
      throw new TypeError(
        `Check "${c.id}" has an empty ${field}. Every check needs what, why, fix and tech.`,
      );
    }
  }
  return Object.freeze({ ...c });
}

/**
 * Checks by id. A Map gives O(1) lookup for suppressions, baselines and docs links, rejects
 * duplicates at insert, and iterates in insertion order so reports are stable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a registry holds checks of any input type
type AnyCheck = Check<any>;

export class CheckRegistry {
  readonly #checks = new Map<string, AnyCheck>();

  register<I>(c: Check<I>): this {
    const existing = this.#checks.get(c.id);
    if (existing) {
      throw new Error(
        `Duplicate check id "${c.id}": "${existing.title}" is already registered, so "${c.title}" cannot be.`,
      );
    }
    this.#checks.set(c.id, c);
    return this;
  }

  get(id: string): AnyCheck | undefined {
    return this.#checks.get(id);
  }

  has(id: string): boolean {
    return this.#checks.has(id);
  }

  all(): AnyCheck[] {
    return [...this.#checks.values()];
  }

  byArea(area: Area): AnyCheck[] {
    return this.all().filter((c) => c.area === area);
  }

  get size(): number {
    return this.#checks.size;
  }
}
