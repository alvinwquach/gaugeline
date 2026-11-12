import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ConfigError,
  accessConfigSchema,
  consentConfigSchema,
  imagesConfigSchema,
  cutoverConfigSchema,
  emailsConfigSchema,
  renewalsConfigSchema,
  handoffConfigSchema,
  costConfigSchema,
  changesConfigSchema,
  type ChangesConfig,
  backupsConfigSchema,
  trackersConfigSchema,
  adaptersConfigSchema,
  servicesConfigSchema,
  eventsConfigSchema,
  factsConfigSchema,
  hiddenConfigSchema,
  staleDatesConfigSchema,
  navRulesSchema,
  aiConfigSchema,
  languageRulesSchema,
  listingsConfigSchema,
  crmConfigSchema,
  sourcesConfigSchema,
  switchesConfigSchema,
  freshnessConfigSchema,
  modelConfigSchema,
  pagesConfigSchema,
  paymentsConfigSchema,
  readContainer,
  schemaRulesSchema,
  tagsConfigSchema,
  type AccessConfig,
  type ConsentConfig,
  type CutoverConfig,
  type EmailsConfig,
  type RenewalsConfig,
  type CostConfig,
  type BackupsConfig,
  type TrackersConfig,
  type AdaptersConfig,
  type ServicesConfig,
  type HandoffConfig,
  type EventsConfig,
  type FactsConfig,
  type HiddenConfig,
  type ImagesConfig,
  type NavRules,
  type AiConfig,
  type StaleDatesConfig,
  type LanguageRules,
  type ListingsConfig,
  type CrmConfig,
  type SourcesConfig,
  type SwitchesConfig,
  type FreshnessConfig,
  type ModelConfig,
  type PagesConfig,
  type PaymentsConfig,
  type SchemaRules,
  type TagContainer,
} from "@gaugeline/core";
import type * as z from "zod";

/** The schema guide's file name, read from the working directory until the config file (G29) lands. */
export const SCHEMA_CONFIG_FILE = "gaugeline.schema.json";
/** The language settings' file name, likewise. */
export const LANGUAGES_CONFIG_FILE = "gaugeline.languages.json";
/** The business's declared facts, likewise. */
export const FACTS_CONFIG_FILE = "gaugeline.facts.json";
/** The business's payment handles and links, likewise. */
export const PAYMENTS_CONFIG_FILE = "gaugeline.payments.json";
/** What the project says about its rendered emails (a text version is expected, click-tracking patterns), likewise. */
export const EMAILS_CONFIG_FILE = "gaugeline.emails.json";
/** What the project says about its renewals (the registered name when it is unusual, the Vercel projects), likewise. Tokens stay in the environment. */
export const RENEWALS_CONFIG_FILE = "gaugeline.renewals.json";
/** Who the client and the freelancer are, and which Vercel and Sanity projects to read, for the handoff report, likewise. Tokens stay in the environment. */
export const HANDOFF_CONFIG_FILE = "gaugeline.handoff.json";
/** What the project says about its hosting cost (the pages that should be cached, other pages to visit, the usage window), likewise. Tokens stay in the environment. */
export const COST_CONFIG_FILE = "gaugeline.cost.json";
/** Where a client's content and database are backed up (the Supabase project, the Sanity dataset, export folders, how old is too old), likewise. Tokens stay in the environment. */
export const BACKUPS_CONFIG_FILE = "gaugeline.backups.json";
/** The freelancer's own packages, prices and brand, for `gaugeline audit --pack`, likewise. No keys. */
export const SERVICES_CONFIG_FILE = "gaugeline.services.json";
/** The paths that count as sensitive for the tracker checks (--trackers), likewise. Nothing in it is a key. */
export const TRACKERS_CONFIG_FILE = "gaugeline.trackers.json";
/** The content systems to read (`adapters`: Sanity now), the fields to fingerprint and where items live, likewise. Keys stay in the environment. */
export const ADAPTERS_CONFIG_FILE = "gaugeline.adapters.json";
/** The database project and roles to test its access rules as, likewise. Keys stay in the environment. */
export const ACCESS_CONFIG_FILE = "gaugeline.access.json";
/** The business listings to compare with the site (Google, Yelp, Apple, bio links), likewise. Keys stay in the environment. */
export const LISTINGS_CONFIG_FILE = "gaugeline.listings.json";
/** The CRM to read leads from through its own read-only MCP server (Salesforce), likewise. The access token stays in the environment. */
export const CRM_CONFIG_FILE = "gaugeline.crm.json";
/** The databases to read named queries from (Postgres, Supabase), likewise. Connection strings stay in the environment. */
export const SOURCES_CONFIG_FILE = "gaugeline.sources.json";
/** What the site must show for each switch, 86 list and capacity (pre-orders off, an item 86'd, sold out), likewise. Names, paths and phrases only. */
export const SWITCHES_CONFIG_FILE = "gaugeline.switches.json";
/** How recent the numbers on a page should be (a sync that stopped, a prediction for a past game), likewise. Paths, selectors, durations and source names only. */
export const FRESHNESS_CONFIG_FILE = "gaugeline.freshness.json";
/** The content model: the schema file, which listings and blocks are built from which types, likewise (model-* checks). Paths, selectors, type and field names only. */
export const MODEL_CONFIG_FILE = "gaugeline.model.json";
/** Sections hidden until launch, likewise. */
export const HIDDEN_CONFIG_FILE = "gaugeline.hidden.json";
/** The tracking plan: which clicks must push which event, likewise. */
export const EVENTS_CONFIG_FILE = "gaugeline.events.json";
/** Where the menus are and which footer links are required, likewise (nav-orphans, nav-footer). */
export const NAV_CONFIG_FILE = "gaugeline.nav.json";
/** Grace days, ignored sentences and historic paths for the out-of-date copy checks. */
export const STALE_DATES_CONFIG_FILE = "gaugeline.stale-dates.json";
/** Pages whose loss was intended, each with its reason, likewise (the page checks). */
export const PAGES_CONFIG_FILE = "gaugeline.pages.json";
/** The DKIM selectors to read and the changes meant at cutover, likewise (snapshot, cutover). */
export const CUTOVER_CONFIG_FILE = "gaugeline.cutover.json";
/** The owner's agreement to the probing checks, who gave it and when: the same as --owner-consent. */
export const CONSENT_CONFIG_FILE = "gaugeline.consent.json";
/** The framework image settings to read and the probe address you chose (XF-04): nothing in it is a key. */
export const IMAGES_CONFIG_FILE = "gaugeline.images.json";
/** Where the Tag Manager container export is, likewise. The export is a file: no account is used. */
export const TAGS_CONFIG_FILE = "gaugeline.tags.json";

/** A JSON settings file in `dir`, validated, or undefined when there is none. Invalid is a ConfigError. */
function readJsonConfig<T>(
  dir: string,
  file: string,
  schema: z.ZodType<T>,
  what: string,
): T | undefined {
  const path = join(dir, file);
  if (!existsSync(path)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`, {
      hint: `Fix the file, or remove it to run without ${what}.`,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "the file";
    throw new ConfigError(`${file}: ${where}: ${issue?.message ?? "not valid"}.`, {
      hint: `See the docs for the shape of ${file}.`,
    });
  }
  return parsed.data;
}

export function readSchemaRules(dir: string): SchemaRules | undefined {
  return readJsonConfig(dir, SCHEMA_CONFIG_FILE, schemaRulesSchema, "a schema guide");
}

export function readLanguageRules(dir: string): LanguageRules | undefined {
  return readJsonConfig(dir, LANGUAGES_CONFIG_FILE, languageRulesSchema, "language settings");
}

export function readFacts(dir: string): FactsConfig | undefined {
  return readJsonConfig(dir, FACTS_CONFIG_FILE, factsConfigSchema, "declared facts");
}

export function readPayments(dir: string): PaymentsConfig | undefined {
  return readJsonConfig(dir, PAYMENTS_CONFIG_FILE, paymentsConfigSchema, "payment details");
}

export function readEmailsConfig(dir: string): EmailsConfig | undefined {
  return readJsonConfig(dir, EMAILS_CONFIG_FILE, emailsConfigSchema, "the email settings");
}

export function readRenewalsConfig(dir: string): RenewalsConfig | undefined {
  return readJsonConfig(dir, RENEWALS_CONFIG_FILE, renewalsConfigSchema, "the renewals settings");
}

export function readHandoffConfig(dir: string): HandoffConfig | undefined {
  return readJsonConfig(dir, HANDOFF_CONFIG_FILE, handoffConfigSchema, "the handoff settings");
}

export function readCostConfig(dir: string): CostConfig | undefined {
  return readJsonConfig(dir, COST_CONFIG_FILE, costConfigSchema, "the hosting cost settings");
}

export function readBackupsConfig(dir: string): BackupsConfig | undefined {
  return readJsonConfig(dir, BACKUPS_CONFIG_FILE, backupsConfigSchema, "the backup settings");
}

export function readServicesConfig(dir: string): ServicesConfig | undefined {
  return readJsonConfig(dir, SERVICES_CONFIG_FILE, servicesConfigSchema, "your packages");
}

export const AI_CONFIG_FILE = "gaugeline.ai.json";

export function readAiConfig(dir: string): AiConfig | undefined {
  return readJsonConfig(dir, AI_CONFIG_FILE, aiConfigSchema, "the AI crawler settings");
}

export function readTrackersConfig(dir: string): TrackersConfig | undefined {
  return readJsonConfig(dir, TRACKERS_CONFIG_FILE, trackersConfigSchema, "the tracker settings");
}

export const CHANGES_CONFIG_FILE = "gaugeline.changes.json";

export function readChangesConfig(dir: string): ChangesConfig | undefined {
  return readJsonConfig(dir, CHANGES_CONFIG_FILE, changesConfigSchema, "the what-changed settings");
}

export function readAdaptersConfig(dir: string): AdaptersConfig | undefined {
  return readJsonConfig(dir, ADAPTERS_CONFIG_FILE, adaptersConfigSchema, "the content adapters");
}

export function readAccess(dir: string): AccessConfig | undefined {
  return readJsonConfig(dir, ACCESS_CONFIG_FILE, accessConfigSchema, "database access checks");
}

export function readListingsConfig(dir: string): ListingsConfig | undefined {
  return readJsonConfig(dir, LISTINGS_CONFIG_FILE, listingsConfigSchema, "listing checks");
}

export function readCrmConfig(dir: string): CrmConfig | undefined {
  return readJsonConfig(dir, CRM_CONFIG_FILE, crmConfigSchema, "the CRM lead checks");
}

export function readSourcesConfig(dir: string): SourcesConfig | undefined {
  return readJsonConfig(dir, SOURCES_CONFIG_FILE, sourcesConfigSchema, "database sources");
}

export function readSwitchesConfig(dir: string): SwitchesConfig | undefined {
  return readJsonConfig(dir, SWITCHES_CONFIG_FILE, switchesConfigSchema, "switch checks");
}

export function readFreshnessConfig(dir: string): FreshnessConfig | undefined {
  return readJsonConfig(dir, FRESHNESS_CONFIG_FILE, freshnessConfigSchema, "data freshness checks");
}

export function readModelConfig(dir: string): ModelConfig | undefined {
  return readJsonConfig(dir, MODEL_CONFIG_FILE, modelConfigSchema, "content model checks");
}

/** Largest Apple Business Connect export read: a few hundred locations is well under it. */
const MAX_EXPORT_BYTES = 2_000_000;

/**
 * The Apple Business Connect export gaugeline.listings.json names (relative to that file), as text.
 * Apple has no read API for a business's listing, so the owner exports a file and this is it.
 */
export function readAppleExport(dir: string, config: ListingsConfig): string | undefined {
  if (!config.apple) return undefined;
  const path = resolve(dirname(join(dir, LISTINGS_CONFIG_FILE)), config.apple.csv);
  try {
    const text = readFileSync(path, "utf8");
    if (text.length > MAX_EXPORT_BYTES)
      throw new ConfigError(
        `${LISTINGS_CONFIG_FILE}: apple.csv: ${config.apple.csv} is over 2 MB, which is not an export of one business.`,
      );
    return text;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    const code = (err as { code?: string }).code;
    throw new ConfigError(
      code === "ENOENT"
        ? `${LISTINGS_CONFIG_FILE}: apple.csv: ${config.apple.csv} was not found.`
        : `${LISTINGS_CONFIG_FILE}: apple.csv: ${config.apple.csv} could not be read (${code ?? "an error"}).`,
      { hint: "Export your locations from Apple Business Connect as a CSV and name that file." },
    );
  }
}

export function readHidden(dir: string): HiddenConfig | undefined {
  return readJsonConfig(dir, HIDDEN_CONFIG_FILE, hiddenConfigSchema, "hidden sections");
}

/** The container export gaugeline.tags.json names (relative to that file), read and parsed. */
export function readTags(dir: string): TagContainer | undefined {
  const config = readJsonConfig(dir, TAGS_CONFIG_FILE, tagsConfigSchema, "the tag rule checks");
  if (!config) return undefined;
  const path = resolve(dirname(join(dir, TAGS_CONFIG_FILE)), config.container);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new ConfigError(
      code === "ENOENT"
        ? `${TAGS_CONFIG_FILE}: container: ${config.container} was not found.`
        : `${config.container} is not valid JSON: ${(err as Error).message}`,
      {
        hint: "Export the container from Tag Manager (Admin > Export container) and name that file.",
      },
    );
  }
  return readContainer(json, config.container);
}

export function readEvents(dir: string): EventsConfig | undefined {
  return readJsonConfig(dir, EVENTS_CONFIG_FILE, eventsConfigSchema, "the click event checks");
}

export function readNavRules(dir: string): NavRules | undefined {
  return readJsonConfig(dir, NAV_CONFIG_FILE, navRulesSchema, "the menu settings");
}

export function readStaleDates(dir: string): StaleDatesConfig | undefined {
  return readJsonConfig(
    dir,
    STALE_DATES_CONFIG_FILE,
    staleDatesConfigSchema,
    "the out-of-date copy settings",
  )?.staleDates;
}

export function readCutoverConfig(dir: string): CutoverConfig | undefined {
  return readJsonConfig(dir, CUTOVER_CONFIG_FILE, cutoverConfigSchema, "the cutover settings");
}

export function readConsent(dir: string): ConsentConfig | undefined {
  return readJsonConfig(dir, CONSENT_CONFIG_FILE, consentConfigSchema, "the probing checks");
}

export function readImagesJson(dir: string): ImagesConfig | undefined {
  return readJsonConfig(
    dir,
    IMAGES_CONFIG_FILE,
    imagesConfigSchema,
    "the image optimizer settings",
  );
}

export function readPagesConfig(dir: string): PagesConfig | undefined {
  return readJsonConfig(dir, PAGES_CONFIG_FILE, pagesConfigSchema, "the expected page changes");
}
