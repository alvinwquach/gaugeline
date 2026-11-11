import { defineCheck } from "../model.js";
import { normaliseUrl } from "../normalise.js";
import type { PageSnapshot } from "../snapshot.js";
import { shortUrl } from "./site-helpers.js";

export const feedDuplicate = defineCheck<PageSnapshot>({
  id: "feed-duplicate",
  size: "S",
  done: "Each feed serves its own collection.",
  estimateChanges: "A filter copied between feeds is one edit each.",
  area: "Search & sharing",
  severity: "medium",
  title: "Two of your feeds serve the same posts",
  what: "Two feeds the page advertises list exactly the same item links.",
  why: "Subscribers to one feed get the other's posts (a news feed serving the blog, say), and readers who follow both see everything twice.",
  fix: "Point each feed at its own collection, usually a query or category filter that was copied from the other.",
  tech: "The advertised feeds read for feed-broken (at most 3), compared as Sets of normalised item links: equal and non-empty, in any order. Sharing most items is not a duplicate",
  async run(page, ctx) {
    const feeds = (await ctx.site?.())?.feeds ?? [];
    const sets = feeds.map((f) => {
      const links = new Set<string>();
      for (const l of f.itemLinks) {
        try {
          links.add(normaliseUrl(l));
        } catch {
          // not an address
        }
      }
      return { url: f.url, links };
    });
    const origin = new URL(page.finalUrl).origin;
    const out = [];
    for (let i = 0; i < sets.length; i++)
      for (let j = i + 1; j < sets.length; j++) {
        const a = sets[i];
        const b = sets[j];
        if (!a || !b || a.links.size === 0 || a.links.size !== b.links.size) continue;
        if (![...a.links].every((l) => b.links.has(l))) continue;
        out.push({
          checkId: "feed-duplicate",
          severity: "medium" as const,
          title: this.title,
          evidence: `${shortUrl(a.url, origin)} and ${shortUrl(b.url, origin)} list the same ${a.links.size} items`,
          url: page.finalUrl,
        });
      }
    return out;
  },
});
