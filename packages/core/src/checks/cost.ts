import type { CheckContext, Finding } from "../model.js";
import { defineCheck } from "../model.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import type { PageSnapshot } from "../snapshot.js";
import { DEFAULT_MINIMUM_SECONDS } from "../cost/config.js";
import { judgePage, type CauseId, type PageRead } from "../cost/judge.js";
import { isMarkedStatic, type Cost } from "../cost/reader.js";
import { detectJumps, jumpPhrase } from "../cost/usage.js";

const clip = (text: string): string => escapeInvisible(text, 120);

/** The cost reader, or undefined when the run did not ask for it. Without it these checks do nothing. */
const reader = (ctx: CheckContext): Cost | undefined => ctx.cost;

const NO_STATIC =
  'no page is marked static in gaugeline.cost.json (for example "static": ["/", "/menu"]), so Gaugeline cannot tell which pages should be served from a cache';

/**
 * The pages read for a cost check, judged. A page that could not be visited, or visited twice without a
 * page to compare, is could-not-check with the reason, never a pass: a page marked static is noted by
 * the caching checks, every page by the first one, so the same page is not noted three times.
 */
async function judged(
  page: PageSnapshot,
  ctx: CheckContext,
  cause: CauseId,
): Promise<Finding[] | undefined> {
  const cost = reader(ctx);
  if (!cost) return undefined;
  const minimum = cost.config.minimumSeconds ?? DEFAULT_MINIMUM_SECONDS;
  const statics = cost.config.static ?? [];
  const caching = cause !== "output-changes-every-request";
  if (caching && statics.length === 0) {
    ctx.couldNotCheck?.(page.finalUrl, NO_STATIC);
    return [];
  }
  const out: Finding[] = [];
  const reads: PageRead[] = await cost.pages(page);
  for (const read of reads) {
    if (!read.ok) {
      if (!caching || isMarkedStatic(read.path, statics))
        ctx.couldNotCheck?.(read.url, read.reason);
      continue;
    }
    const j = judgePage(read, minimum);
    const verdict =
      cause === "output-changes-every-request"
        ? j.changes
        : cause === "never-cached"
          ? j.caching
          : j.lifetime;
    // A visit that was not a page is noted once, by the first check, not again by each caching check.
    const unreadable = j.changes.kind === "unreadable";
    if (verdict.kind === "unreadable" || (verdict.kind === "unknown" && (!caching || !unreadable)))
      ctx.couldNotCheck?.(read.url, verdict.reason);
    const found = j.causes.find((c) => c.id === cause);
    if (found)
      out.push({
        checkId: cause,
        severity: found.severity,
        title: TITLES[cause],
        evidence: found.evidence,
        url: clip(read.url),
      });
  }
  return out;
}

const TITLES: Record<CauseId, string> = {
  "output-changes-every-request": "The page's HTML is different on every request",
  "never-cached": "A page marked static is never served from the CDN's cache",
  "revalidate-too-often": "A page marked static is rebuilt too often",
};

export const outputChangesEveryRequest = defineCheck<PageSnapshot>({
  id: "output-changes-every-request",
  size: "M",
  done: "Two visits a few seconds apart give the same HTML, so the host can keep one copy and serve it, and the hosting bill stops growing with every visitor.",
  estimateChanges:
    "Often an hour to find the value (a clock, a counter, a random id) and move it to the browser or behind a longer cache time. Longer when the page is built from a CMS query that includes it.",
  area: "Visitors",
  severity: "medium",
  title: TITLES["output-changes-every-request"],
  what: "Visiting the page twice, a few seconds apart, gives different HTML even after nonces and CSRF values are ignored.",
  why: "A page that is different on every visit cannot be cached, so the host builds it again for every visitor. On a Next.js site that is the usual cause of a hosting bill that grows faster than the traffic, and it makes the page slower as well.",
  fix: "Find the first difference in the finding. If it is a time, a counter or a random id, print it in the browser instead of when the page is built, or move it behind a cache lifetime. If it comes from a CMS query, ask whether that part has to be fresh on every visit.",
  tech: "Two GETs of the page about 3 seconds apart, the first being the one the check already made, both with no cookies (a variant a cookie would choose is the one a first-time visitor gets). Before comparing, volatile values are blanked by a fixed table: nonce attributes and 'nonce-' sources, the value of csrf-token meta tags and hidden CSRF fields, Cloudflare's scrambled emails; whitespace is collapsed. The finding quotes the first differing word in each body. A cookie whose name looks like an experiment (ab_test, variant, bucket) is named in the evidence. Pure string comparison: the same two bodies give the same answer. Only with --cost or gaugeline cost; pages listed under \"pages\" in gaugeline.cost.json are visited too",
  async run(page, ctx) {
    return (await judged(page, ctx, "output-changes-every-request")) ?? [];
  },
});

export const neverCached = defineCheck<PageSnapshot>({
  id: "never-cached",
  size: "M",
  done: "The page's second visit is served from the CDN's cache (a hit), so the host does not build it for every visitor.",
  estimateChanges:
    "Usually a cache header or a revalidate setting, an hour. More when something the page reads (a cookie, a header, a no-store fetch) opts it out of the cache.",
  area: "Visitors",
  severity: "low",
  title: TITLES["never-cached"],
  what: "A page you marked static in gaugeline.cost.json was a cache miss on both of two visits a few seconds apart.",
  why: "A page that is meant to be the same for everyone should be built once and served from the CDN. When every visit is a miss, the host does the work every time, which costs money and makes the page slower.",
  fix: "Look for what opts the page out of the cache: a Cache-Control of no-store or private, a cookie or header the page reads, a fetch with cache: no-store, or a dynamic function. On Next.js, make the route static or give it a revalidate time.",
  tech: 'Only pages marked static ("static" in gaugeline.cost.json: a path or a "/folder/*"). Two GETs about 3 seconds apart, no cookies. The cache state is read from x-vercel-cache (HIT, STALE, PRERENDER, REVALIDATED are hits; MISS, BYPASS misses), cf-cache-status (HIT, STALE, UPDATING, REVALIDATED; MISS, EXPIRED, BYPASS, DYNAMIC) and a positive Age; a hit on either visit passes. A response with none of those is could-not-check, not a guess. When a lifetime of a second or more explains the misses, revalidate-too-often is reported instead',
  async run(page, ctx) {
    return (await judged(page, ctx, "never-cached")) ?? [];
  },
});

export const revalidateTooOften = defineCheck<PageSnapshot>({
  id: "revalidate-too-often",
  size: "S",
  done: "The page's cache lifetime is at least the minimum in gaugeline.cost.json (60 seconds by default), so the host keeps a copy instead of rebuilding it.",
  estimateChanges:
    "Minutes: a number in a revalidate setting or a header. Decide with the client how stale a page may be.",
  area: "Visitors",
  severity: "low",
  title: TITLES["revalidate-too-often"],
  what: "A page you marked static sends a cache lifetime shorter than the minimum you set (60 seconds unless you changed it).",
  why: "A lifetime of a second or two means the host rebuilds the page about as often as it is visited. A page that changes once a day does not need that, and every rebuild is billed.",
  fix: "Raise the lifetime to what the content needs: an hour for a menu, a day for an about page. On Next.js that is the revalidate setting; on any host it is the s-maxage in Cache-Control.",
  tech: 'Only pages marked static ("static" in gaugeline.cost.json). The lifetime is s-maxage when Cache-Control has one, else max-age; no-store, no-cache and private count as zero. A max-age with no s-maxage is the browser\'s lifetime: when the CDN answered a hit (Vercel and Cloudflare keep such a page until the next deploy or purge) it is fine. Compared with "minimumSeconds" (default 60). A page with no Cache-Control header is could-not-check. A zero lifetime on a page that never hit the cache is reported as never-cached instead',
  async run(page, ctx) {
    return (await judged(page, ctx, "revalidate-too-often")) ?? [];
  },
});

export const usageJump = defineCheck<PageSnapshot>({
  id: "usage-jump",
  size: "M",
  done: "Yesterday's usage is back within the multiple of its recent average, or the jump is explained (a campaign, a launch) and the plan covers it.",
  estimateChanges:
    "An hour to find the cause in the provider's usage page (a page that stopped caching, an image loop, a crawler). Longer if the fix is a plan change the client has to approve.",
  area: "Visitors",
  severity: "medium",
  title: "Hosting usage jumped",
  what: "A usage figure the hosting provider reports for yesterday is more than a set multiple (2 by default) of its average over the 14 days before.",
  why: "A site can quietly multiply its hosting bill when a page stops caching or a loop starts. The jump shows up in the usage figures days before the invoice, which is the time to fix it, and to tell the client before they find out.",
  fix: "Open the provider's usage page for the metric named, and look for the day it started: a deploy, a page that began changing on every visit (see output-changes-every-request), a new image or API call. Fix the cause, then run again tomorrow.",
  tech: "Read-only, one GET of the provider's usage with the token in the environment: Vercel's billing charges (GAUGELINE_VERCEL_TOKEN; Vercel has no read-only token type, so use one scoped to the team). Each service and unit is a metric, and the billed cost one more, summed by UTC day in thousandths (integers). The latest complete day before today by the injected clock is compared with the mean of the days before it (window and multiple in gaugeline.cost.json): flagged when more than the multiple, ignoring a day under one whole unit and a metric with no earlier usage. Sanity's usage has no documented read API, so it is could-not-check. Not applicable to a site on Wix, Squarespace, Webflow or Framer: a fixed plan. No token is could-not-check; the page checks still run",
  async run(page, ctx) {
    const cost = reader(ctx);
    if (!cost) return [];
    // A hosted builder charges one plan price: there is no usage to watch, which is not a failure to read it.
    if (cost.builder(page)) return [];
    const usage = await cost.usage();
    const at = ctx.now?.() ?? new Date();
    // No provider is set up: one note naming every variable. Otherwise a provider that is set up and could
    // not be read is noted on its own, and one that is not set up is left out (it was never asked for).
    const nothingSetUp = usage.providers.every((p) => !p.ok && !p.configured);
    if (nothingSetUp)
      ctx.couldNotCheck?.(
        page.finalUrl,
        usage.providers.map((p) => (p.ok ? "" : p.reason)).join("; "),
      );
    const out: Finding[] = [];
    for (const p of usage.providers) {
      if (!p.ok) {
        if (p.configured) ctx.couldNotCheck?.(`usage:${p.provider.toLowerCase()}`, p.reason);
        continue;
      }
      for (const j of detectJumps(p.metrics, at, cost.usageSettings))
        out.push({
          checkId: "usage-jump",
          severity: "medium",
          title: this.title,
          evidence: `${p.provider} ${clip(j.metric)} ${jumpPhrase(j)} (flagged above ${j.multiple} times)`,
          url: `usage:${p.provider.toLowerCase()}:${clip(j.metric)}`,
        });
    }
    return out;
  },
});

export const COST_CHECKS = [
  outputChangesEveryRequest,
  neverCached,
  revalidateTooOften,
  usageJump,
] as const;
