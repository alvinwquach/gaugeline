import { createPageRegistry } from "./checks/index.js";
import type { Fetcher } from "./fetcher.js";
import { createBudget, sampleCounts, type Budget } from "./limits.js";
import type { CheckRegistry } from "./model.js";
import type { ProgressSink } from "./progress.js";
import { NO_PAGE_CHECKS } from "./checks/blocked.js";
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
import { lazyTagAnalysis, summarise, type TagSummary } from "./tags/analyse.js";
import type { TagContainer } from "./tags/read-container.js";
import type { RunSnapshot } from "./run-snapshot.js";
import { lazyPages } from "./pages.js";
import { lazyDatasets } from "./sanity.js";
import { lazyScripts } from "./scripts.js";
import type { FactsConfig } from "./facts/types.js";
import type { PaymentsConfig } from "./payments/types.js";
import type { SchemaRules } from "./schema-rules.js";
import { lazyImageSample } from "./checks/images/refs.js";
import { frameworkLinks, lazyLinkSample, linkCandidates } from "./links.js";
import type { RunExpectations } from "./model.js";
import { lazySiteContext } from "./site-context.js";
import { buildSnapshot, type PageSnapshot } from "./snapshot.js";

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
  /** The database project to read as each role, with its keys already read from the environment. */
  access?: AccessSettings;
  /** Public DNS for the email record checks. Without one, they find nothing and nothing is resolved. */
  dns?: DnsReader;
  /** Sections hidden until launch. */
  hidden?: HiddenConfig;
  /** The tracking plan: elements whose clicks must push an event (gaugeline.events.json). */
  events?: EventsConfig;
  /** Clicks the plan's elements in a rendered page. None until rendered reads (G39): could not check. */
  eventObserver?: EventObserver;
  /** A Tag Manager container export, already read from its file. */
  tags?: TagContainer;
  /** The last run's snapshot (--since last): the change checks compare with it. */
  previous?: RunSnapshot;
}

export interface SiteCheck {
  snapshot: PageSnapshot;
  result: RunResult;
  budget: Budget;
  /** How many of the container's triggers can fire, when a tag check read them. */
  tags?: TagSummary;
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
  const snapshot = buildSnapshot(await opts.fetcher.getSite(opts.address));
  sink({ step: "robots-sitemap" });
  // The same candidates the link checks sample: same-site http(s), no #fragment of this page.
  const sameSite = dedupeUrls(linkCandidates(snapshot).map((l) => l.url));
  budget.take("frameworkAddresses", frameworkLinks(snapshot));
  sink({ step: "links", count: Math.min(sameSite.length, budget.remaining("links")) });
  sink({ step: "scripts" });
  const images = lazyImageSample({ page: snapshot, fetcher: opts.fetcher, budget });
  const site = lazySiteContext({ page: snapshot, fetcher: opts.fetcher, budget });
  const registry = opts.registry ?? createPageRegistry();
  const pages = lazyPages({ page: snapshot, fetcher: opts.fetcher, budget });
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
  const wanted = registry
    .all()
    .map((c) => c.id)
    .filter((id) => (!opts.only || opts.only.includes(id)) && !(opts.skip ?? []).includes(id));
  const refusedIds =
    pageOutcome.kind === "refused" ? wanted.filter((id) => !NO_PAGE_CHECKS.includes(id)) : [];
  const only =
    pageOutcome.kind === "refused" ? wanted.filter((id) => NO_PAGE_CHECKS.includes(id)) : opts.only;
  const result = await runChecks(snapshot, registry, {
    ctx: {
      fetcher: opts.fetcher,
      budget,
      site,
      links: lazyLinkSample({ page: snapshot, fetcher: opts.fetcher, budget }),
      apps: lazyAppLookups({ page: snapshot, fetcher: opts.fetcher, budget }),
      images,
      calendars: lazyCalendars({ page: snapshot, fetcher: opts.fetcher, budget }),
      ...(opts.now ? { now: opts.now } : {}),
      pages,
      scripts: lazyScripts({ page: snapshot, fetcher: opts.fetcher, budget }),
      datasets: lazyDatasets({ page: snapshot, fetcher: opts.fetcher, budget }),
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
      ...(opts.access
        ? { access: lazyAccess({ fetcher: opts.fetcher, budget, settings: opts.access }) }
        : {}),
      ...(opts.schemaRules ? { schemaRules: opts.schemaRules } : {}),
      imagesIfSampled: () => images.peek(),
      ...(opts.expect ? { expect: opts.expect } : {}),
    },
    onProgress: sink,
    ...(only ? { only } : {}),
    ...(opts.skip ? { skip: opts.skip } : {}),
  });
  if (pageOutcome.kind === "refused") {
    const reason = `the page ${describeRefusal(pageOutcome)}`;
    result.couldNotCheck.push(...refusedIds.map((id) => ({ id, reason, url: snapshot.finalUrl })));
  }
  result.sampled = sampleCounts(budget.summary());
  const analysis = await tagRules?.peek();
  return { snapshot, result, budget, ...(analysis ? { tags: summarise(analysis) } : {}) };
}
