import { createPageRegistry } from "./checks/index.js";
import type { Fetcher } from "./fetcher.js";
import { createBudget, sampleCounts, type Budget } from "./limits.js";
import type { CheckRegistry } from "./model.js";
import type { ProgressSink } from "./progress.js";
import { NO_PAGE_CHECKS } from "./checks/blocked.js";
import { LISTING_CHECKS } from "./presets.js";
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
import { lazyDatabases, type DatabasesSettings } from "./connectors/postgres/read.js";
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
  /** The databases to read named queries from (gaugeline.sources.json), with their variables already copied. */
  databases?: DatabasesSettings;
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
  const skip = listingsOff
    ? [...(opts.skip ?? []), ...LISTING_CHECKS.filter((id) => registered.has(id))]
    : opts.skip;
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
      ...(opts.databases ? { databases: lazyDatabases(opts.databases, opts.fetcher) } : {}),
      imagesIfSampled: () => images.peek(),
      ...(opts.expect ? { expect: opts.expect } : {}),
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
