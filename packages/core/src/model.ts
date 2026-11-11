import type * as z from "zod";
import type { Fetcher } from "./fetcher.js";
import type { Budget } from "./limits.js";
import type { findingSchema } from "./result.js";
import type { AppLookup } from "./apps.js";
import type { CalendarRead } from "./calendars.js";
import type { FactsConfig } from "./facts/types.js";
import type { PaymentsConfig } from "./payments/types.js";
import type { LanguageGroup, LanguageRules } from "./languages.js";
import type { SchemaRules } from "./schema-rules.js";
import type { AccessRead } from "./access/probe.js";
import type { DnsReader } from "./dns.js";
import type { Renewals } from "./renewals/reader.js";
import type { Handoff } from "./handoff/reader.js";
import type { Cost } from "./cost/reader.js";
import type { Trackers } from "./trackers/reader.js";
import type { HiddenConfig } from "./hidden.js";
import type { NavRules } from "./nav/read-regions.js";
import type { ContentNow, PagesConfig } from "./snapshot/compare.js";
import type { EventsRead } from "./events/observe.js";
import type { TagAnalysis } from "./tags/analyse.js";
import type { TagContainer } from "./tags/read-container.js";
import type { RunSnapshot } from "./run-snapshot.js";
import type { DatasetRead } from "./sanity.js";
import type { ListingsRead } from "./listings/read.js";
import type { CrmRead } from "./sources/crm-read.js";
import type { DatabasesRead } from "./connectors/postgres/read.js";
import type { AssertionsRead } from "./assertions/read.js";
import type { Freshness } from "./freshness/read.js";
import type { ContentModel } from "./content-model/read.js";
import type { StatePages } from "./switches/pages.js";
import type { SwitchesRead } from "./switches/types.js";
import type { ScriptRead } from "./scripts.js";
import type { PageSnapshot } from "./snapshot.js";
import type { ImageSample } from "./checks/images/refs.js";
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
export type Finding = z.infer<typeof findingSchema> & {
  /**
   * Plan findings only: the key a group of rows shares and every line in it, so one decision is one
   * finding. Not part of the page result schema (result.v2.json): page checks never set it.
   */
  group?: FindingGroup;
};

/** The rows one plan finding covers: what they share, and the line of each in the plan. */
export interface FindingGroup {
  key: string;
  lines: number[];
}

/** Effort to fix, used by the work order (G28): Small, Medium or Large. */
export type Size = "S" | "M" | "L";

export const SIZES = ["S", "M", "L"] as const satisfies readonly Size[];

/**
 * Points per size: Small 1, Medium 3, Large 8. A Record, so the compiler checks all three sizes are
 * here, and the table the docs show is visible on one line. Integers, so a total never drifts.
 */
export const POINTS: Readonly<Record<Size, number>> = Object.freeze({ S: 1, M: 3, L: 8 });

/** Passed to every check. Later branches add the fetcher, the budget and the run's options. */
/** What the person running the check says should be true, for checks that compare against it. */
export interface RunExpectations {
  /** The app's name as it should appear in the App Store and on Google Play. */
  appName?: string;
  /** The venue's IANA time zone ("America/Los_Angeles"), for event dates. */
  timeZone?: string;
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
  /** The run's same-site image sample (headers only), probed once on first use. */
  images?: () => Promise<ImageSample>;
  /**
   * The image sample only if another check already asked for it, else undefined. For checks that
   * must make no request of their own (page-heavy).
   */
  imagesIfSampled?: () => Promise<ImageSample> | undefined;
  /** The page's .ics calendars, read once on first use. */
  calendars?: () => Promise<CalendarRead[]>;
  /** The checked page and a few other same-site pages, fetched once on first use. */
  pages?: () => Promise<PageSnapshot[]>;
  /** The checked page's other-language versions, read once on first use. */
  languages?: () => Promise<LanguageGroup>;
  /** How the site spells its language versions (gaugeline.languages.json). */
  languageRules?: LanguageRules;
  /** The business's declared facts (gaugeline.facts.json). */
  facts?: FactsConfig;
  /**
   * When documents last changed in a connected content source, by page address. Absent until a
   * source is connected (branch 30): next-stale-after-publish is then unchecked.
   */
  contentChanges?: () => Promise<{ url: string; changedAt: Date }[]>;
  /**
   * Record something this check could not read because the site refused it (401, 403, 429, a
   * challenge page): it goes under the check in couldNotCheck, and the check is not passed.
   */
  couldNotCheck?(url: string, reason: string): void;
  /** The last run's snapshot of this page (--since last), for the checks that report a change. */
  previous?: RunSnapshot;
  /** --since last was asked for: a missing snapshot then means "nothing saved yet", not "not asked". */
  baselineRequested?: boolean;
  /** Sections hidden until launch (gaugeline.hidden.json). */
  hidden?: HiddenConfig;
  /** Where the menus are and which footer links are required (gaugeline.nav.json). */
  navRules?: NavRules;
  /**
   * Each page saved with the last run (--since last), as it is now: read once on first use. Absent
   * when the last run saved no pages.
   */
  contentNow?: () => Promise<Map<string, ContentNow>>;
  /** Pages whose loss was intended, with the reason (gaugeline.pages.json). */
  expectedChanges?: PagesConfig["expectedChanges"];
  /** The tracking plan's elements, clicked by the run's observer, once on first use (gaugeline.events.json). */
  events?: () => Promise<EventsRead>;
  /** The Tag Manager container export named in gaugeline.tags.json, read from the file only. */
  tagContainer?: TagContainer;
  /** That container's triggers judged against the pages read, once on first use. */
  tagRules?: () => Promise<TagAnalysis>;
  /** The business's payment handles and links (gaugeline.payments.json). */
  payments?: PaymentsConfig;
  /** The team's schema guide, when one is configured (gaugeline.schema.json). */
  schemaRules?: SchemaRules;
  /** The run's clock. Injectable so every date check is deterministic; defaults to the real time. */
  now?: () => Date;
  /** The page's same-site JavaScript files, fetched once on first use. */
  scripts?: () => Promise<ScriptRead[]>;
  /** The Sanity datasets the page's images name, asked for counts and type names once on first use. */
  datasets?: () => Promise<DatasetRead[]>;
  /** The configured database project, read as each role (counts only) once on first use. */
  access?: () => Promise<AccessRead>;
  /** Public DNS (TXT and MX only), for the email record checks. Absent: those checks find nothing. */
  dns?: DnsReader;
  /**
   * What the renewals checks read (the domain's registration through RDAP, the certificates of the bare
   * domain and www, the tokens and Vercel projects the user configured), once each on first use. Absent
   * unless the run asked for renewals: those checks then do nothing.
   */
  renewals?: Renewals;
  /**
   * What the handoff checks read (who holds the domain, the hosting, the content studio and the listing,
   * from the public record and the tokens the freelancer already has), once each on first use. Absent
   * unless the run is `gaugeline handoff`: those checks then do nothing.
   */
  handoff?: Handoff;
  /**
   * What the cost checks read: every page visited twice a few seconds apart and the account usage of the
   * providers whose tokens are set, once each on first use. Absent unless the run is `gaugeline cost` or
   * has --cost: those checks then do nothing.
   */
  cost?: Cost;
  /**
   * What the tracker checks read: the public file of each Tag Manager container a page loads, once each on
   * first use, and the settings (the paths that count as sensitive). Absent unless the run has --trackers:
   * those checks then do nothing.
   */
  trackers?: Trackers;
  /** The page's App Store and Google Play apps, looked up once on first use. */
  apps?: () => Promise<AppLookup[]>;
  /**
   * The business listings named in gaugeline.listings.json (Google, Yelp, Apple, social bios), read
   * once on first use. Absent when no listing is configured: the listing checks then say they could
   * not check, never that they passed.
   */
  listings?: () => Promise<ListingsRead>;
  /**
   * The CRM named in gaugeline.crm.json, read once on first use through its own read-only MCP server:
   * field names, a sample of recent leads reduced to ids and empty fields, and a lead count. Absent when
   * none is configured: the lead checks are then not run, or say they could not check if asked for by id.
   */
  crm?: () => Promise<CrmRead>;
  /**
   * The named queries in gaugeline.sources.json (Postgres, Supabase), read once on first use, read
   * only. Absent when no source is configured. Data assertions have their own entry below; the
   * switches check reads this one.
   */
  databases?: () => Promise<DatabasesRead>;
  /**
   * The data assertions in gaugeline.sources.json (SELECTs that must return no rows), run once on
   * first use through the same read-only database connector. Absent when none is configured.
   */
  assertions?: () => Promise<AssertionsRead>;
  /**
   * The switches, 86 list and capacity in gaugeline.switches.json, each read from its source once on
   * first use. Absent when the file is not there: the switch checks then say they could not check.
   */
  switches?: () => Promise<SwitchesRead>;
  /**
   * The pages gaugeline.switches.json and gaugeline.freshness.json name, each read once with GET on
   * first use (they share the run's allowance for them).
   */
  statePages?: StatePages;
  /**
   * How recent the numbers on a page should be (gaugeline.freshness.json), with the readers of the
   * sources it names. Absent when the file is not there: the freshness checks then say they could not check.
   */
  freshness?: Freshness;
  /**
   * The content model (gaugeline.model.json): the schema file it names and a way to ask the Sanity
   * dataset for counts and ids. Absent when the file is not there: the model checks then say they
   * could not check.
   */
  model?: ContentModel;
  /** Values the run was told to expect (for example the app's name). Until the config file, API only. */
  expect?: RunExpectations;
  /**
   * The site's owner agreed to probing checks (--owner-consent, or gaugeline.consent.json): checks
   * that ask a gated route for what it protects with no credentials. Absent or false: they ask
   * nothing and say so.
   */
  ownerConsent?: boolean;
  /** Paths of the site's repository route files (--routes), for the download route probe. Names only: no file is read. */
  routeFiles?: readonly string[];
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
  /** Effort to fix, by the kind of fix and not by how bad it is (G28). Required: the work order reads it. */
  size: Size;
  /** What fixed looks like, in a sentence a person can confirm by running Gaugeline again (G28). */
  done: string;
  /** What makes this fix smaller or bigger than its size says, so nobody quotes blind (G28). */
  estimateChanges: string;
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
  // The work order (G28) reads the size from the check; a missing one fails here, at definition.
  if (!(SIZES as readonly string[]).includes(c.size as string)) {
    throw new TypeError(
      `Check "${c.id}" ${c.size === undefined ? "has no size" : `has the size ${JSON.stringify(c.size)}`}. Give it size "S", "M" or "L" (1, 3 or 8 points), a done sentence and an estimateChanges sentence.`,
    );
  }
  for (const field of ["done", "estimateChanges"] as const) {
    if (typeof c[field] !== "string" || c[field].trim() === "") {
      throw new TypeError(`Check "${c.id}" has an empty ${field}. Every check needs one.`);
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
