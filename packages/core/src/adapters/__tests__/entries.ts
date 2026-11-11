// check-community: allow-email (invented addresses at reserved example domains, for the members fixture)
import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createSanityAdapter } from "../sanity.js";
import { createSitemapFeedAdapter } from "../sitemap-feed.js";
import type { ContractEntry } from "./contract.js";
import { CONTENT_MARKERS, sanityTransport } from "./sanity-fixture.js";
import { OAKLINE, OAKLINE_MARKERS, oaklineRoutes, serve } from "./sitemap-feed-fixture.js";

/**
 * One entry per adapter. A new adapter's branch adds its entry here (its recorded answers go in a
 * fixture file beside sanity-fixture.ts) and the whole contract suite runs against it.
 */
const SANITY_KEY = testKey("sanity-adapter");
const SANITY_ENV = {
  SANITY_PROJECT_ID: "fern8hl1",
  SANITY_DATASET: "production",
  SANITY_TOKEN: SANITY_KEY,
};

const json = (body: unknown) =>
  Promise.resolve({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

/** The projects API answers handoff reads: two people and one API token, as Sanity lists members. */
const sanityMembers: Transport = (url) => {
  if (url.pathname.endsWith("/users/su_rosa,su_dev"))
    return json([
      { id: "su_rosa", email: "Rosa.Ferrer@fernhill-coaching.example" },
      { id: "su_dev", email: "dev@freelancer.example" },
    ]);
  return json({
    displayName: "Fernhill Coaching",
    members: [
      { id: "su_rosa", role: "administrator", isRobot: false },
      { id: "su_dev", role: "developer", isRobot: false },
      { id: "su_bot", role: "viewer", isRobot: true },
    ],
  });
};

export const sanityEntry: ContractEntry = {
  id: "sanity",
  make: ({ fetcher, sleep }) => createSanityAdapter({ env: SANITY_ENV, fetcher, sleep }),
  transport: () => sanityTransport(undefined, { token: SANITY_KEY }),
  key: SANITY_KEY,
  secrets: Object.values(CONTENT_MARKERS),
  expected: {
    types: [
      { name: "package", count: 2 },
      { name: "post", count: 3 },
      { name: "testimonial", count: 2 },
    ],
    fields: {
      type: "post",
      counts: { title: 3, summary: 2, "slug.current": 3 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["post"], fields: { post: ["title", "summary"] } },
      ids: ["post-faq", "post-spring", "post-welcome"],
    },
    draftsReachable: true,
  },
  rateLimit: { options: { types: ["package", "post"] }, succeedFirst: 1, atLeast: 2 },
  members: {
    transport: () => sanityMembers,
    expected: [
      { emailMasked: "r***@fernhill-coaching.example", role: "admin" },
      { emailMasked: "d***@freelancer.example", role: "member" },
    ],
    addresses: ["Rosa.Ferrer", "rosa.ferrer", "dev@freelancer"],
  },
};

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

export const ENTRIES: readonly ContractEntry[] = [sanityEntry, sitemapFeedEntry];
