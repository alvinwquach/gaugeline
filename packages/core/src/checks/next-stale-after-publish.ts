import { defineCheck } from "../model.js";
import { isNextSite, readCache } from "../next/detect.js";
import type { PageSnapshot } from "../snapshot.js";

/** How long a published change may take to reach the page before it counts as stale. */
export const STALE_AFTER_MINUTES = 10;

export const nextStaleAfterPublish = defineCheck<PageSnapshot>({
  id: "next-stale-after-publish",
  size: "M",
  done: "An edit in the CMS shows on the live page without a redeploy.",
  estimateChanges:
    "An on-demand revalidation webhook is set up in the CMS and the app. A revalidate time is one line but gives slower updates.",
  area: "Launch day",
  severity: "medium",
  title: "The page still shows an old copy after an edit",
  what: "With a content source connected, this Next.js page is still a cached copy made before its document last changed, more than 10 minutes after the change.",
  why: "Editors publish a fix and visitors keep seeing the old version, so the fix looks broken.",
  fix: "Revalidate the page when its document changes (an on-demand revalidation webhook from the CMS), or lower its revalidate time.",
  tech: "Next.js sites with a content source (branch 30) only, otherwise unchecked: x-nextjs-cache or x-vercel-cache HIT or STALE with an Age header, the copy's age older than the document's last change, and the change more than 10 minutes ago. Without an Age header nothing is reported",
  async run(page, ctx) {
    if (!ctx.contentChanges || !isNextSite(page)) return [];
    const cache = readCache(page.hops.at(-1)?.headers ?? {});
    if ((cache.state !== "HIT" && cache.state !== "STALE") || cache.ageSeconds === undefined)
      return [];
    const now = (ctx.now ?? (() => new Date()))().getTime();
    const bornAt = now - cache.ageSeconds * 1000;
    const path = new URL(page.finalUrl).pathname;
    const change = (await ctx.contentChanges()).find((c) => {
      try {
        return new URL(c.url).pathname === path;
      } catch {
        return false;
      }
    });
    if (!change) return [];
    const since = now - change.changedAt.getTime();
    if (bornAt >= change.changedAt.getTime() || since <= STALE_AFTER_MINUTES * 60_000) return [];
    const minutes = (ms: number) => Math.round(ms / 60_000);
    return [
      {
        checkId: "next-stale-after-publish",
        severity: "medium",
        title: this.title,
        evidence: `${path} is a cached copy (${cache.state}, ${minutes(cache.ageSeconds * 1000)} minutes old) and its document changed ${minutes(since)} minutes ago`,
        url: page.finalUrl,
      },
    ];
  },
});
