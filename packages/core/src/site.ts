import { createPageRegistry } from "./checks/index.js";
import type { Fetcher } from "./fetcher.js";
import { createBudget, sampleCounts, type Budget } from "./limits.js";
import type { CheckRegistry } from "./model.js";
import type { ProgressSink } from "./progress.js";
import { NO_PAGE_CHECKS } from "./checks/blocked.js";
import {
  ASSERTION_CHECKS,
  CRM_CHECKS,
  FRESHNESS_CHECKS,
  LISTING_CHECKS,
  PROBING_CHECKS,
  SWITCH_CHECKS,
} from "./presets.js";
import { classifyHop, describeRefusal } from "./refusal.js";
import { runChecks, type RunOptions, type RunResult } from "./run.js";
import { dedupeUrls } from "./sample.js";
import { lazyAppLookups } from "./apps.js";
import { lazyCalendars } from "./calendars.js";
import { lazyLanguageGroup, type LanguageRules } from "./languages.js";
import { lazyAccess } from "./access/probe.js";
import type { AccessSettings } from "./access/types.js";
import type { DnsReader } from "./dns.js";
import type { HiddenConfig } from "./hidden.js";
import { lazyEvents, type EventObserver } from "./events/observe.js";
import type { EventsConfig } from "./events/types.js";
import type { NavRules } from "./nav/read-regions.js";
import { lazyTagAnalysis, summarise, type TagSummary } from "./tags/analyse.js";
import type { TagContainer } from "./tags/read-container.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { lazyPages } from "./pages.js";
import { contentGains, type ContentNow, type PagesConfig } from "./snapshot/compare.js";
import { lazyContentNow } from "./snapshot/now.js";
import { pathKey } from "./checks/page-shared.js";
import {
  buildContentSnapshot,
  contentKey,
  type ContentSnapshot,
} from "./snapshot/page-snapshot.js";
import { lazyDatasets } from "./sanity.js";
import { lazyListings, noListings, type ListingsSettings } from "./listings/read.js";
import { lazyCrm, noCrm, type CrmSettings } from "./sources/crm-read.js";
import { lazyDatabases, type DatabasesSettings } from "./connectors/postgres/read.js";
import { lazyAssertions, sourcesRedactor } from "./assertions/read.js";
import { createStatePages } from "./switches/pages.js";
import { lazySwitches, type SwitchesSettings } from "./switches/read.js";
import { createFreshness, type FreshnessSettings } from "./freshness/read.js";
import { lazyScripts } from "./scripts.js";
import type { FactsConfig } from "./facts/types.js";
import type { PaymentsConfig } from "./payments/types.js";
import type { SchemaRules } from "./schema-rules.js";
import { lazyImageSample } from "./checks/images/refs.js";
import { frameworkLinks, lazyLinkSample, linkCandidates } from "./links.js";
import type { RunExpectations } from "./model.js";
import { lazySiteContext } from "./site-context.js";
import { buildSnapshot, type PageSnapshot } from "./snapshot.js";
import { inKind, kinded, requestRows, type RequestRow } from "./request-log.js";
import { leaksView, remembered, type LeaksView } from "./leaks-view.js";
import { pageData, type PageData } from "./run-view.js";

export interface SiteCheckOptions {
  /** What the person typed: a bare domain or a full address. */
  address: string;
  fetcher: Fetcher;
  registry?: CheckRegistry;
  budget?: Budget;
  onProgress?: ProgressSink;
  only?: RunOptions["only"];
  skip?: RunOptions["skip"];
  /** Values to compare against, such as the expected app name. */
  expect?: RunExpectations;
  /** The run's clock, for date checks. Defaults to the real time. */
  now?: () => Date;
  /** The team's schema guide, for the structured data rules checks. */
  schemaRules?: SchemaRules;
  /** How the site spells its language versions. */
  languageRules?: LanguageRules;
  /** The business's declared facts. */
  facts?: FactsConfig;
  /** The business's payment handles and links. */
  payments?: PaymentsConfig;
  /** The business listings to compare with the site (gaugeline.listings.json), with their keys already read. */
  listings?: ListingsSettings;
  /** The CRM to read leads from through its own read-only MCP server (gaugeline.crm.json). */
  crm?: CrmSettings;
  /** The databases to read named queries from (gaugeline.sources.json), with their variables already copied. */
  databases?: DatabasesSettings;
  /** What the site must show for each switch, 86 list and capacity (gaugeline.switches.json), with its Sanity variables already copied. */
  switches?: SwitchesSettings;
  /** How recent the numbers on a page should be (gaugeline.freshness.json), with its Sanity variables already copied. */
  freshness?: FreshnessSettings;
  /** The database project to read as each role, with its keys already read from the environment. */
  access?: AccessSettings;
  /** Public DNS for the email record checks. Without one, they find nothing and nothing is resolved. */
  dns?: DnsReader;
  /** Sections hidden until launch. */
  hidden?: HiddenConfig;
  /** Where the menus are and which footer links are required (gaugeline.nav.json). */
  nav?: NavRules;
  /** The tracking plan: elements whose clicks must push an event (gaugeline.events.json). */
  events?: EventsConfig;
  /** Clicks the plan's elements in a rendered page. None until rendered reads (G39): could not check. */
  eventObserver?: EventObserver;
  /** A Tag Manager container export, already read from its file. */
  tags?: TagContainer;
  /** The last run's snapshot (--since last): the change checks compare with it. */
  previous?: RunSnapshot;
  /** --since last was asked for, whether or not a last run was found. */
  baselineRequested?: boolean;
  /** Pages whose loss was intended (gaugeline.pages.json). */
  pagesConfig?: PagesConfig;
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Without it they do not run. */
  ownerConsent?: boolean;
  /** Paths of the repository's route files (--routes), for the download route probe. Names only. */
  routeFiles?: readonly string[];
}

export interface SiteCheck {
  snapshot: PageSnapshot;
  result: RunResult;
  budget: Budget;
  /** How many of the container's triggers can fire, when a tag check read them. */
  tags?: TagSummary;
  /**
   * With --since last: what each page read holds, by path, to save with the run. The pages
   * from the last run that are still there are kept, so a page outside this run's sample isn't lost.
   */
  contents?: Record<string, ContentSnapshot>;
  /** With --since last: gains since the last run (new pages, sections, items), and the expected changes. Information, never findings. */
  contentNotes?: string[];
  /** Every address this check requested, by kind and then in the order asked (the app's Pages checked view). */
  requests?: RequestRow[];
  /** What the page declares, as read without JavaScript (the app's Search data view). */
  page: PageData;
  /** What the dataset, key and preview checks read (the app's Leaks & access view). */
  leaks: LeaksView;
}

/**
 * One full check of a site, in the order the docs describe: load the page without JavaScript,
 * read robots.txt and the sitemap, check the links, scan the JavaScript, then run every check.
 * Each step is announced once through onProgress.
 */
export async function checkSite(opts: SiteCheckOptions): Promise<SiteCheck> {
  const sink = opts.onProgress ?? (() => undefined);
  const budget = opts.budget ?? createBudget();
  sink({ step: "load-page" });
  // A fetcher kept across checks has history already: only what this check asks for is reported.
  const before = opts.fetcher.history?.().length ?? 0;
  const snapshot = buildSnapshot(await inKind("page", () => opts.fetcher.getSite(opts.address)));
  sink({ step: "robots-sitemap" });
  // The same candidates the link checks sample: same-site http(s), no #fragment of this page.
  const sameSite = dedupeUrls(linkCandidates(snapshot).map((l) => l.url));
  budget.take("frameworkAddresses", frameworkLinks(snapshot));
  sink({ step: "links", count: Math.min(sameSite.length, budget.remaining("links")) });
  sink({ step: "scripts" });
  const images = kinded(
    "image",
    lazyImageSample({ page: snapshot, fetcher: opts.fetcher, budget }),
  );
  const site = lazySiteContext({ page: snapshot, fetcher: opts.fetcher, budget });
  const registry = opts.registry ?? createPageRegistry();
  const pages = kinded("extra-page", lazyPages({ page: snapshot, fetcher: opts.fetcher, budget }));
  const saved = opts.previous?.pages;
  const contentNow = saved
    ? lazyContentNow({
        previous: saved,
        pages,
        fetcher: opts.fetcher,
        origin: new URL(snapshot.finalUrl).origin,
      })
    : undefined;
  const container = opts.tags;
  const tagRules = container
    ? lazyTagAnalysis(async () => ({
        container,
        pages: await pages(),
        known: (await site()).sitemapUrls,
      }))
    : undefined;
  // The page itself refused: run only the checks that need no page; list the rest as could not
  // check. No retry, no other user agent, no extra headers.
  const pageOutcome = classifyHop(snapshot.hops.at(-1));
  // The listing checks compare listings with the site, so they run when gaugeline.listings.json
  // names one. Without it they are not run (so not passed either), unless a caller asked for one by
  // id: that one says it could not check.
  const asked = LISTING_CHECKS.some((id) => opts.only?.includes(id));
  const listingsOff = !opts.listings && !asked;
  const registered = new Set(registry.all().map((c) => c.id));
  // The data assertion check is the same: it runs when the sources file holds assertions.
  const assertionsAsked = ASSERTION_CHECKS.some((id) => opts.only?.includes(id));
  const assertionsOff = !(opts.databases?.config.assertions?.length ?? 0) && !assertionsAsked;
  // The switch checks likewise: they run when gaugeline.switches.json is there.
  const switchesAsked = SWITCH_CHECKS.some((id) => opts.only?.includes(id));
  const switchesOff = !opts.switches && !switchesAsked;
  // And the freshness checks: they run when gaugeline.freshness.json is there.
  const freshnessAsked = FRESHNESS_CHECKS.some((id) => opts.only?.includes(id));
  const freshnessOff = !opts.freshness && !freshnessAsked;
  // The CRM lead checks likewise: they run when gaugeline.crm.json is there.
  const crmAsked = CRM_CHECKS.some((id) => opts.only?.includes(id));
  const crmOff = !opts.crm && !crmAsked;
  // The probing checks ask gated routes for what they protect, so they run only with consent.
  const probingAsked = PROBING_CHECKS.some((id) => opts.only?.includes(id));
  const probingOff = opts.ownerConsent !== true && !probingAsked;
  const switchedOff = [
    ...(probingOff ? PROBING_CHECKS.filter((id) => registered.has(id)) : []),
    ...(crmOff ? CRM_CHECKS.filter((id) => registered.has(id)) : []),
    ...(listingsOff ? LISTING_CHECKS.filter((id) => registered.has(id)) : []),
    ...(assertionsOff ? ASSERTION_CHECKS.filter((id) => registered.has(id)) : []),
    ...(switchesOff ? SWITCH_CHECKS.filter((id) => registered.has(id)) : []),
    ...(freshnessOff ? FRESHNESS_CHECKS.filter((id) => registered.has(id)) : []),
  ];
  const skip = switchedOff.length > 0 ? [...(opts.skip ?? []), ...switchedOff] : opts.skip;
  const wanted = registry
    .all()
    .map((c) => c.id)
    .filter((id) => (!opts.only || opts.only.includes(id)) && !(skip ?? []).includes(id));
  const refusedIds =
    pageOutcome.kind === "refused" ? wanted.filter((id) => !NO_PAGE_CHECKS.includes(id)) : [];
  const only =
    pageOutcome.kind === "refused" ? wanted.filter((id) => NO_PAGE_CHECKS.includes(id)) : opts.only;
  // Kept so the app can show what the key and dataset checks read; nothing is asked a second time.
  const scripts = remembered(
    kinded("script", lazyScripts({ page: snapshot, fetcher: opts.fetcher, budget })),
  );
  const datasets = remembered(lazyDatasets({ page: snapshot, fetcher: opts.fetcher, budget }));
  // One read of the named queries, shared by the checks that read databases and the switch checks.
  const databases = opts.databases ? lazyDatabases(opts.databases, opts.fetcher) : undefined;
  // What the readers of a rule's source (a Sanity field, a named query) share: the fetcher, the
  // databases above, and the redactor that blanks every key and connection string.
  const sourceDeps = {
    fetcher: opts.fetcher,
    redact: opts.databases
      ? sourcesRedactor(opts.databases.config, opts.databases.env)
      : (text: string) => text,
    ...(opts.databases && databases
      ? { databases: { config: opts.databases.config, read: databases } }
      : {}),
  };
  const result = await runChecks(snapshot, registry, {
    ctx: {
      fetcher: opts.fetcher,
      budget,
      site,
      links: kinded("link", lazyLinkSample({ page: snapshot, fetcher: opts.fetcher, budget })),
      apps: lazyAppLookups({ page: snapshot, fetcher: opts.fetcher, budget }),
      images,
      calendars: lazyCalendars({ page: snapshot, fetcher: opts.fetcher, budget }),
      ...(opts.now ? { now: opts.now } : {}),
      pages,
      scripts,
      datasets,
      languages: lazyLanguageGroup({
        page: snapshot,
        fetcher: opts.fetcher,
        budget,
        ...(opts.languageRules ? { rules: opts.languageRules } : {}),
        sitemapAlternates: async () => (await site()).sitemapAlternates,
      }),
      ...(opts.languageRules ? { languageRules: opts.languageRules } : {}),
      ...(opts.facts ? { facts: opts.facts } : {}),
      ...(opts.payments ? { payments: opts.payments } : {}),
      ...(opts.dns ? { dns: opts.dns } : {}),
      ...(opts.hidden ? { hidden: opts.hidden } : {}),
      ...(opts.nav ? { navRules: opts.nav } : {}),
      ...(container && tagRules ? { tagContainer: container, tagRules } : {}),
      ...(opts.events
        ? {
            events: lazyEvents({
              page: snapshot,
              config: opts.events,
              ...(opts.eventObserver ? { observer: opts.eventObserver } : {}),
            }),
          }
        : {}),
      ...(opts.previous ? { previous: opts.previous } : {}),
      ...(opts.baselineRequested ? { baselineRequested: true } : {}),
      ...(contentNow ? { contentNow } : {}),
      ...(opts.pagesConfig ? { expectedChanges: opts.pagesConfig.expectedChanges } : {}),
      ...(opts.access
        ? { access: lazyAccess({ fetcher: opts.fetcher, budget, settings: opts.access }) }
        : {}),
      ...(opts.schemaRules ? { schemaRules: opts.schemaRules } : {}),
      ...(opts.listings
        ? { listings: lazyListings(opts.listings, opts.fetcher) }
        : asked
          ? { listings: () => Promise.resolve(noListings()) }
          : {}),
      ...(opts.crm
        ? {
            crm: lazyCrm(opts.crm, {
              now: opts.now ?? (() => new Date()),
              ...(opts.previous ? { previousTakenAt: opts.previous.takenAt } : {}),
            }),
          }
        : crmAsked
          ? { crm: () => Promise.resolve(noCrm()) }
          : {}),
      ...(databases ? { databases } : {}),
      ...(opts.switches ? { switches: lazySwitches(opts.switches, sourceDeps) } : {}),
      ...(opts.freshness ? { freshness: createFreshness(opts.freshness, sourceDeps) } : {}),
      // The switches file and the freshness file name pages the run reads itself, once each, from
      // one shared allowance.
      ...(opts.switches || opts.freshness
        ? {
            statePages: createStatePages({
              fetcher: opts.fetcher,
              budget,
              known: [snapshot],
            }),
          }
        : {}),
      ...((opts.databases?.config.assertions?.length ?? 0) > 0 && opts.databases
        ? { assertions: lazyAssertions(opts.databases, opts.fetcher) }
        : {}),
      imagesIfSampled: () => images.peek(),
      ...(opts.expect ? { expect: opts.expect } : {}),
      ...(opts.ownerConsent ? { ownerConsent: true } : {}),
      ...(opts.routeFiles ? { routeFiles: opts.routeFiles } : {}),
    },
    onProgress: sink,
    ...(only ? { only } : {}),
    ...(skip ? { skip } : {}),
  });
  if (pageOutcome.kind === "refused") {
    const reason = `the page ${describeRefusal(pageOutcome)}`;
    result.couldNotCheck.push(...refusedIds.map((id) => ({ id, reason, url: snapshot.finalUrl })));
  }
  result.sampled = sampleCounts(budget.summary());
  const analysis = await tagRules?.peek();
  const content =
    opts.baselineRequested && pageOutcome.kind !== "refused"
      ? await savedContents(await pages(), contentNow, saved, opts.pagesConfig)
      : undefined;
  const history = opts.fetcher.history?.();
  const [datasetReads, scriptReads] = await Promise.all([datasets.peek(), scripts.peek()]);
  return {
    snapshot,
    result,
    budget,
    page: pageData(snapshot),
    leaks: leaksView({
      page: snapshot,
      ...(datasetReads ? { datasets: datasetReads } : {}),
      ...(scriptReads ? { scripts: scriptReads } : {}),
    }),
    ...(history ? { requests: requestRows(history.slice(before)) } : {}),
    ...(analysis ? { tags: summarise(analysis) } : {}),
    ...(content ? { contents: content.contents, contentNotes: content.notes } : {}),
  };
}

/** The pages to save with this run, and what they gained against the last one. */
async function savedContents(
  read: readonly PageSnapshot[],
  contentNow: (() => Promise<Map<string, ContentNow>>) | undefined,
  saved: Readonly<Record<string, ContentSnapshot>> | undefined,
  config: PagesConfig | undefined,
): Promise<{ contents: Record<string, ContentSnapshot>; notes: string[] }> {
  const contents: Record<string, ContentSnapshot> = {};
  for (const p of read) {
    const last = p.hops.at(-1);
    if (last && last.status >= 200 && last.status < 300) {
      const key = contentKey(p.requestedUrl);
      // A page that redirects elsewhere is saved under neither address.
      if (key === contentKey(p.finalUrl)) contents[key] = buildContentSnapshot(p);
    }
  }
  if (contentNow)
    for (const [key, now] of await contentNow())
      if (now.kind === "page" && !(key in contents)) contents[key] = now.snap;
  const notes = saved ? contentGains(saved, contents) : [];
  for (const e of config?.expectedChanges ?? [])
    if (saved && pathKey(e.path) in saved)
      notes.push(`Expected change, not reported: ${e.path} (${e.reason})`);
  // Keys sorted, so the saved file diffs cleanly between runs.
  return {
    contents: Object.fromEntries(Object.entries(contents).sort(([a], [b]) => (a < b ? -1 : 1))),
    notes,
  };
}
