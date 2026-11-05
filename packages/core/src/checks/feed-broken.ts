import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { finalStatus } from "./site-helpers.js";

export const feedBroken = defineCheck<PageSnapshot>({
  id: "feed-broken",
  area: "Search & sharing",
  severity: "high",
  title: "The feed this page advertises is broken",
  what: "The page links to an RSS or Atom feed that returns an error (4xx or 5xx).",
  why: "Feed readers, podcast apps and newsletter tools that follow the site stop getting new posts, usually without anyone noticing.",
  fix: 'Restore the feed at that address, or update the link rel="alternate" tag to where the feed lives now.',
  tech: "an advertised feed returns 4xx or 5xx",
  async run(_page, ctx) {
    const site = await ctx.site?.();
    if (!site) return [];
    return site.feeds.flatMap((feed) => {
      const status = finalStatus(feed.hops);
      if (status === undefined || status < 400) return [];
      return [
        {
          checkId: "feed-broken",
          severity: "high" as const,
          title: this.title,
          evidence: `${feed.url} returned ${status}`,
          url: feed.url,
        },
      ];
    });
  },
});
