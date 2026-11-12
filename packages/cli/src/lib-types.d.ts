/**
 * Types for `import { defineCheck } from "gaugeline"`, written by hand because the engine is bundled
 * into the CLI and is not a dependency. They are a subset of core's: a check you write sees the
 * fields below. src/__tests__/lib-types.test.ts fails the build when core's types stop fitting.
 */
export type Severity = "high" | "medium" | "low";
export type Size = "S" | "M" | "L";
export type Area =
  "Search & sharing" | "Visitors" | "Sales & prices" | "Leads" | "Security & email" | "Launch day";

/** One thing found on a site. `evidence` is the technical line; never put a secret in it. */
export interface Finding {
  checkId: string;
  severity: Severity;
  title: string;
  evidence: string;
  url: string;
}

/** The page a check reads: the parts of Gaugeline's page snapshot a check of your own needs. */
export interface PageSnapshot {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  title?: string;
  canonical?: string;
  headings: { level: 1 | 2 | 3; text: string; id?: string }[];
  links: { href: string; text: string; rel?: string; sameSite: boolean }[];
  images: { src: string; alt: string | null; width?: number; height?: number }[];
  jsonLd: unknown[];
  og: Record<string, string>;
  htmlLang?: string;
}

/** What a check is given besides the page. Requests go through the run's read-only fetcher only. */
export interface CheckContext {
  /** A note for you, the developer. */
  warn(message: string): void;
  /** Say a page could not be read: that is neither a finding nor a pass. */
  couldNotCheck?(url: string, reason: string): void;
  /** The run's clock. */
  now?: () => Date;
}

export interface Check<Input = PageSnapshot> {
  /** Kebab-case, and never the id of a built-in check. */
  id: string;
  area: Area;
  severity: Severity;
  title: string;
  what: string;
  why: string;
  fix: string;
  /** The technical line in the checks reference, for whoever fixes it. */
  tech: string;
  /** Effort to fix: S, M or L (1, 3 or 8 points). */
  size: Size;
  /** What fixed looks like, in a sentence a person can confirm by running Gaugeline again. */
  done: string;
  /** What makes the fix smaller or bigger than its size says. */
  estimateChanges: string;
  run(input: Input, ctx: CheckContext): Finding[] | Promise<Finding[]>;
}

/** Check your own rule is complete (id, texts, size) and freeze it. Throws a TypeError naming what is missing. */
export function defineCheck<Input = PageSnapshot>(check: Check<Input>): Check<Input>;

/** The shape of gaugeline.config.ts's default export. */
export interface Config {
  /** "block" fails --ci at any severity, "warn" never fails it, "off" does not run the check. */
  checks?: Record<string, "block" | "warn" | "off">;
  custom?: Check<PageSnapshot>[];
  /** Snooze a finding with a reason and a last day (YYYY-MM-DD). */
  suppress?: { id: string; url?: string; until: string; reason: string }[];
}
