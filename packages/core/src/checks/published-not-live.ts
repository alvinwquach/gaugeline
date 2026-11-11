import type { CheckContext, Finding } from "../model.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import {
  CACHE_HEADERS,
  type CacheHeaders,
  type LiveItem,
  type PublishedReading,
} from "../published/reader.js";
import { escapeInvisible } from "./hidden-text/escape.js";

const clip = (text: string): string => escapeInvisible(text, 120);
const MINUTE = 60_000;

/** Whole minutes between an item's update and the run's clock. Never negative: a clock a little behind is "just now". */
function minutesSince(updatedAt: string, now: string): number {
  return Math.max(0, Math.floor((Date.parse(now) - Date.parse(updatedAt)) / MINUTE));
}

/** True when the item changed longer ago than the grace period: a page is allowed to lag for that long. */
const pastGrace = (item: LiveItem, r: PublishedReading): boolean =>
  minutesSince(item.updatedAt, r.now) > r.graceMinutes;

const ago = (minutes: number): string => {
  if (minutes < 120) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} hours ago`;
  return `${Math.floor(minutes / 1440)} days ago`;
};

/** "age 3540, last-modified ..., cache-control ...": what the page's headers say about its cache. */
export function describeHeaders(headers: CacheHeaders): string {
  const parts = CACHE_HEADERS.flatMap((h) =>
    headers[h] !== undefined ? [`${h} ${clip(headers[h])}`] : [],
  );
  return parts.length > 0 ? parts.join(", ") : "none of age, last-modified or cache headers";
}

const label = (i: LiveItem): string => `${clip(i.type)} ${clip(i.name)}`;

/** The site's reading for this check's first page, once per site, or undefined (not asked, or already reported). */
async function readingFor(
  id: string,
  page: PageSnapshot,
  ctx: CheckContext,
): Promise<PublishedReading | undefined> {
  const published = ctx.published;
  if (!published) return undefined;
  const site = new URL(page.finalUrl).origin;
  if (!published.claim(id, site)) return undefined;
  return published.read(site, ctx.now?.() ?? new Date());
}

export const publishedNotLive = defineCheck<PageSnapshot>({
  id: "published-not-live",
  size: "M",
  done: "Every item the client changed lately shows on its page within the grace period, and the cause of any delay (a failed revalidation, a cache set too long) is fixed.",
  estimateChanges:
    "An hour to find why the page was not rebuilt: a revalidation webhook that fails, a path that is not revalidated, a cache time that is too long. More when the hosting plan has to change.",
  area: "Visitors",
  severity: "high",
  title: "Content was published in the CMS and the live page still shows something else",
  what: "An item was changed in the content system more than the grace period ago, and its live page does not show the configured field (the title unless you chose others).",
  why: "The client published and believes the site changed. Visitors still see the old menu, the old price or the old opening hours, and nobody finds out until the client complains.",
  fix: "Look at the cache headers in the finding: an age close to the time since the change means the page is cached and not revalidated. Check the revalidation webhook (did the CMS call it, did the site answer 2xx), the path or tag it revalidates, and the page's cache lifetime. Then republish the item or purge the page.",
  tech: "Only with --published. For items the content system's published() lists as changed in the last N days (live.days, default 7) with an address on the site (the adapter's own, or the type's urls template), one GET of the page through the fetcher, on the site's own host only, at most live.maxPages pages (default 40, newest change first). The fingerprint of each configured field (live.fields, then the adapter's fingerprint settings, then title) is compared with the page's title, its parts around a site name, og:title and headings, ignoring case, entities, spacing and typographic quotes. It is a finding when a field differs and the item changed more than live.graceMinutes ago (default 15). Evidence is the item's update time, the page's Age, Last-Modified, Cache-Control and cache status headers, and the names of the fields that differ, never their text. Webhook delivery history is not read. The same input and clock give the same findings",
  async run(page, ctx) {
    const r = await readingFor(this.id, page, ctx);
    if (!r) return [];
    for (const note of r.notes) ctx.couldNotCheck?.(r.site, note);
    const out: Finding[] = [];
    for (const item of r.items) {
      if (item.outcome.kind === "unread") {
        ctx.couldNotCheck?.(
          item.url,
          `${label(item)}: the page was not read (${clip(item.outcome.reason)}).`,
        );
        continue;
      }
      if (item.outcome.kind !== "page" || item.outcome.differing.length === 0) continue;
      if (!pastGrace(item, r)) continue;
      const minutes = minutesSince(item.updatedAt, r.now);
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${label(item)} was saved ${item.updatedAt} (${ago(minutes)}; grace ${r.graceMinutes} minutes). The page differs in: ${item.outcome.differing.map(clip).join(", ")}. Page headers: ${describeHeaders(item.outcome.headers)}`,
        url: clip(item.url),
      });
    }
    return out;
  },
});

export const livePageMissing = defineCheck<PageSnapshot>({
  id: "live-page-missing",
  size: "M",
  done: "Every published item that is meant to have a page has one, and a run of Gaugeline finds no published item whose address answers 404.",
  estimateChanges:
    "Minutes when the address pattern in the settings is wrong. An hour or more when the site does not build pages for new items, or the route is missing.",
  area: "Visitors",
  severity: "high",
  title: "A published item has no page on the live site",
  what: "An item that changed lately is published in the content system, and the address it should live at answers 404 (or 410).",
  why: "The client published a page and gave out the link. Visitors, and anyone the client sent it to, get a not-found page.",
  fix: "Check the address pattern (urls in gaugeline.adapters.json, or the platform's own) against the site's routes. If the pattern is right, the site did not build the page: trigger the build or revalidation, and look at the webhook that should have done it.",
  tech: "Only with --published. The same read as published-not-live: one GET of the address of each item changed in the last N days; a 404 or 410 on an item that changed more than live.graceMinutes ago is a finding. An address on another site is never asked for. A page that answers anything else than 2xx, 404 or 410 is could-not-check, never a finding",
  async run(page, ctx) {
    const r = await readingFor(this.id, page, ctx);
    if (!r) return [];
    const out: Finding[] = [];
    for (const item of r.items) {
      if (item.outcome.kind !== "missing" || !pastGrace(item, r)) continue;
      const minutes = minutesSince(item.updatedAt, r.now);
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${label(item)} was saved ${item.updatedAt} (${ago(minutes)}) and its address answers ${item.outcome.status}`,
        url: clip(item.url),
      });
    }
    return out;
  },
});

export const unpublishedStillLive = defineCheck<PageSnapshot>({
  id: "unpublished-still-live",
  size: "M",
  done: "A page for an item that was unpublished or deleted is gone from the site or redirects, and the site's sitemap no longer lists it.",
  estimateChanges:
    "Minutes to purge a page and fix its revalidation. An hour when the site never removes pages for deleted items.",
  area: "Visitors",
  severity: "medium",
  title: "An unpublished or deleted item still has a live page",
  what: "The site's sitemap lists a page that fits the address pattern of a content type, no published item has that address, and the page still answers 200.",
  why: "The client took the item down, perhaps because it was wrong, out of date or private, and visitors and search engines can still read it.",
  fix: "Purge or revalidate the page so it answers 404 or redirects, and check that the sitemap is rebuilt when an item is unpublished. If the page is meant to stay, publish the item again.",
  tech: "Only with --published, and only when the run has a list of the whole site (the sitemap and feed adapter, which is the default) and an adapter with urls templates in gaugeline.adapters.json. Every address in the site's own sitemap that fits a template and that no published item resolves to is asked for with one GET, within the page budget; a 2xx answer is a finding. A list of everything published that is cut short (a rate limit, or more than 2000 items) means this is not looked for, and the reason is could-not-check",
  async run(page, ctx) {
    const r = await readingFor(this.id, page, ctx);
    if (!r) return [];
    return r.stillLive.map((s): Finding => ({
      checkId: this.id,
      severity: this.severity,
      title: this.title,
      evidence: `${clip(s.type)}: ${clip(s.path)} answers ${s.status} and no published item has this address. Page headers: ${describeHeaders(s.headers)}`,
      url: clip(s.url),
    }));
  },
});

export const PUBLISHED_CHECKS = [publishedNotLive, livePageMissing, unpublishedStillLive] as const;
