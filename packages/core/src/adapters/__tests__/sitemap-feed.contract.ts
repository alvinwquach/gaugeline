import { createSitemapFeedAdapter } from "../sitemap-feed.js";
import type { ContractEntry } from "./contract.js";
import { OAKLINE, OAKLINE_MARKERS, oaklineRoutes, serve } from "./sitemap-feed-fixture.js";

/**
 * Oakline Bakery: a Squarespace-style site with a sitemap index, a gzip child, a feed with a missing
 * date and a recipe that is in the feed only. No key, no fields, no drafts (see sitemap-feed-fixture.ts).
 */
export const sitemapFeedEntry: ContractEntry = {
  id: "sitemap-feed",
  make: ({ fetcher, sleep }) => createSitemapFeedAdapter({ fetcher, site: OAKLINE, sleep }),
  transport: () => serve(oaklineRoutes()),
  secrets: Object.values(OAKLINE_MARKERS),
  expected: {
    types: [
      { name: "blog", count: 3 },
      { name: "recipes", count: 1 },
      { name: "shop", count: 2 },
      { name: "top-level", count: 3 },
    ],
    published: {
      options: { types: ["blog", "recipes"] },
      ids: [
        `${OAKLINE}/blog/spring-loaf`,
        `${OAKLINE}/blog/winter-hours`,
        `${OAKLINE}/blog/pop-up-saturday`,
        `${OAKLINE}/rye-recipe`,
      ],
    },
    draftsReachable: "not-applicable",
  },
  // robots.txt, the index and the pages sitemap are answered; the blog sitemap is the first refused.
  rateLimit: { options: { types: ["blog", "top-level"] }, succeedFirst: 3, atLeast: 3 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [sitemapFeedEntry];
