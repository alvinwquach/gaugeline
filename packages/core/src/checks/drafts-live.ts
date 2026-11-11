import { load } from "cheerio/slim";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

/** A Sanity draft document id: drafts. followed by the published id. */
const DRAFT_ID = /^drafts\.[A-Za-z0-9][\w-]*$/;
const DRAFT_IN_ATTR = /(?:^|[\s"',;:=[{(])(drafts\.[A-Za-z0-9][\w-]*)/g;
/** Words a preview or draft-mode banner shows. */
const BANNER = /\b(preview mode|draft mode|viewing a draft|exit preview)\b/i;

function walk(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (DRAFT_ID.test(value)) out.push(value);
  } else if (Array.isArray(value)) for (const v of value) walk(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) walk(v, out);
}

export const draftsLive = defineCheck<PageSnapshot>({
  id: "drafts-live",
  size: "M",
  done: "The live page shows published content only, and a request without a preview cookie gets no drafts.",
  estimateChanges:
    "Preview mode wired into several routes, or the same query repeated in many files, each need the change.",
  area: "Launch day",
  severity: "high",
  title: "Unpublished work is in the live page",
  what: "The published HTML carries Sanity draft document ids (drafts.…) or a preview-mode banner.",
  why: "Drafts are work nobody approved: prices, announcements or pages that weren't meant to be public yet, readable by anyone who opens the page source.",
  fix: "Build the live site with the published perspective (no drafts), turn preview mode off for public requests, and rebuild.",
  tech: "Ids matching drafts.<id> in attribute values or as string values inside JSON script blocks (application/json, ld+json, __NEXT_DATA__), not in prose; or visible text such as Preview mode or Exit preview. Only the count and the first id are reported, never document content",
  run(page) {
    const $ = load(page.hops.at(-1)?.body ?? "");
    const ids: string[] = [];
    $("*").each((_, el) => {
      for (const v of Object.values((el as { attribs?: Record<string, string> }).attribs ?? {}))
        for (const m of v.matchAll(DRAFT_IN_ATTR)) if (m[1]) ids.push(m[1]);
    });
    $(
      'script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__',
    ).each((_, el) => {
      try {
        walk(JSON.parse($(el).text()), ids);
      } catch {
        // not JSON
      }
    });
    const unique = [...new Set(ids)];
    if (unique.length > 0)
      return [
        {
          checkId: "drafts-live",
          severity: "high",
          title: this.title,
          evidence: `${unique.length} draft document id${unique.length === 1 ? "" : "s"} in the published HTML, first "${unique[0] ?? ""}"`,
          url: page.finalUrl,
        },
      ];
    $("script, style, noscript, template").remove();
    const banner = BANNER.exec($.root().text().replace(/\s+/g, " "));
    if (!banner?.[1]) return [];
    return [
      {
        checkId: "drafts-live",
        severity: "high",
        title: this.title,
        evidence: `a preview-mode banner in the published HTML: "${banner[1].replace(/^./, (c) => c.toUpperCase())}"`,
        url: page.finalUrl,
      },
    ];
  },
});
