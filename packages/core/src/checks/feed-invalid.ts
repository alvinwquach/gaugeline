import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { finalStatus } from "./site-helpers.js";

/**
 * Does the body start like a feed: an XML declaration, an <rss> or a <feed> element? A leading
 * BOM, whitespace and comments are skipped. The Content-Type is not consulted: a valid feed served
 * as text/html still works in feed readers.
 */
export function startsLikeFeed(body: string): boolean {
  let rest = body.replace(/^\uFEFF/, "").trimStart();
  while (rest.startsWith("<!--")) {
    const end = rest.indexOf("-->");
    if (end < 0) return false;
    rest = rest.slice(end + 3).trimStart();
  }
  return /^<\?xml[\s?]/i.test(rest) || /^<(?:rss|feed)[\s>/]/.test(rest);
}

export const feedInvalid = defineCheck<PageSnapshot>({
  id: "feed-invalid",
  area: "Search & sharing",
  severity: "medium",
  title: "The feed this page advertises is not a feed",
  what: "The advertised feed address answers, but with something that is not RSS or Atom, often an HTML page.",
  why: "Feed readers cannot read it, so subscribers get nothing. A framework's catch-all route is the usual cause.",
  fix: 'Serve the feed\'s XML at that address, or point the link rel="alternate" tag at the address that does.',
  tech: "the feed body does not start with an XML declaration, <rss> or <feed>",
  async run(_page, ctx) {
    const site = await ctx.site?.();
    if (!site) return [];
    return site.feeds.flatMap((feed) => {
      const status = finalStatus(feed.hops);
      if (status === undefined || status < 200 || status >= 300) return [];
      const body = feed.hops.at(-1)?.body ?? "";
      if (startsLikeFeed(body)) return [];
      const start = body
        .replace(/^\uFEFF/, "")
        .trimStart()
        .slice(0, 40)
        .replace(/\s+/g, " ");
      return [
        {
          checkId: "feed-invalid",
          severity: "medium" as const,
          title: this.title,
          evidence:
            start === ""
              ? `${feed.url} returned an empty body`
              : `${feed.url} starts with "${start}"`,
          url: feed.url,
        },
      ];
    });
  },
});
