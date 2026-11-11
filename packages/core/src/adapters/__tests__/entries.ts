// check-community: allow-email (invented addresses at reserved example domains, for the members fixture)
import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { BUILDERS, createBuilderAdapter } from "../builders.js";
import { createFramerAdapter } from "../framer.js";
import { createSanityAdapter } from "../sanity.js";
import { createSitemapFeedAdapter } from "../sitemap-feed.js";
import { createWebflowAdapter } from "../webflow.js";
import { createWordPressAdapter } from "../wordpress.js";
import {
  TIDEWATER,
  TIDEWATER_MARKERS,
  tidewaterRoutes,
  tidewaterServe,
} from "./builders-fixture.js";
import type { ContractEntry } from "./contract.js";
import { LANTERN, LANTERN_MARKERS, lanternRoutes, lanternServe } from "./framer-fixture.js";
import { CONTENT_MARKERS, sanityTransport } from "./sanity-fixture.js";
import { OAKLINE, OAKLINE_MARKERS, oaklineRoutes, serve } from "./sitemap-feed-fixture.js";
import { SITE_ID, WEBFLOW_MARKERS, webflowTransport } from "./webflow-fixture.js";
import { CONTENT_MARKERS as WP_MARKERS, wordpressTransport } from "./wordpress-fixture.js";

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

/** The Copper Lantern's WordPress: a dedicated user whose application password reads drafts and users. */
const WP_KEY = testKey("wordpress-adapter");
export const WP_USER = "gaugeline-reader";
export const WP_ENV = {
  WORDPRESS_URL: "https://copper-lantern.example",
  WORDPRESS_USER: WP_USER,
  WORDPRESS_APP_PASSWORD: WP_KEY,
};
const wpTransport = () =>
  wordpressTransport(undefined, { app: { user: WP_USER, password: WP_KEY } });

export const wordpressEntry: ContractEntry = {
  id: "wordpress",
  make: ({ fetcher, sleep }) => createWordPressAdapter({ env: WP_ENV, fetcher, sleep }),
  transport: wpTransport,
  key: WP_KEY,
  keyHeader: { value: `Basic ${Buffer.from(`${WP_USER}:${WP_KEY}`).toString("base64")}` },
  secrets: Object.values(WP_MARKERS),
  expected: {
    types: [
      { name: "event", count: 2 },
      { name: "page", count: 3 },
      { name: "post", count: 3 },
    ],
    fields: {
      type: "post",
      counts: { title: 3, excerpt: 2, slug: 3 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["post"], fields: { post: ["title", "excerpt"] } },
      ids: ["11", "12", "13"],
    },
    draftsReachable: true,
  },
  // The first request lists the types and the second reads the pages; the posts are the third.
  rateLimit: { options: { types: ["page", "post"] }, succeedFirst: 2, atLeast: 3 },
  members: {
    transport: wpTransport,
    expected: [
      { emailMasked: "r***@copper-lantern.example", role: "admin" },
      { emailMasked: "d***@freelancer.example", role: "member" },
      { emailMasked: "(address not shown by WordPress)", role: "viewer" },
    ],
    addresses: ["Rosa.Ferrer", "rosa.ferrer", "dev@freelancer"],
  },
};

/**
 * Saltmarsh Supper Club: a Webflow site with events, menu items and testimonials, one event staged and
 * never published, one a draft, one archived, and a menu item with a later edit not yet published (see
 * webflow-fixture.ts). A token with read scopes; the unpublished work is reachable.
 */
const WEBFLOW_KEY = testKey("webflow-adapter");

export const webflowEntry: ContractEntry = {
  id: "webflow",
  make: ({ fetcher, sleep }) =>
    createWebflowAdapter({
      env: { WEBFLOW_TOKEN: WEBFLOW_KEY, WEBFLOW_SITE_ID: SITE_ID },
      fetcher,
      sleep,
    }),
  transport: () => webflowTransport(undefined, { token: WEBFLOW_KEY }),
  key: WEBFLOW_KEY,
  secrets: Object.values(WEBFLOW_MARKERS),
  expected: {
    types: [
      { name: "events", count: 2 },
      { name: "menu-items", count: 2 },
      { name: "testimonials", count: 2 },
    ],
    fields: {
      type: "events",
      counts: { name: 2, summary: 1, slug: 2 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["events"], fields: { events: ["name", "summary"] } },
      ids: ["e-harvest", "e-oyster"],
    },
    draftsReachable: true,
  },
  // The collections and the first events page are answered; the menu items' page is the first refused.
  rateLimit: { options: { types: ["events", "menu-items"] }, succeedFirst: 2, atLeast: 2 },
};

/**
 * Lantern Row: a ceramics pop-up on Framer. The live site's sitemap is all Gaugeline can read: Framer's
 * CMS collections are behind the Server API (a WebSocket library, a key that can also change the
 * project), so there are no fields, no key and no drafts (see framer-fixture.ts).
 */
export const framerEntry: ContractEntry = {
  id: "framer",
  make: ({ fetcher, sleep }) => createFramerAdapter({ fetcher, site: LANTERN, sleep }),
  transport: () => lanternServe(lanternRoutes()),
  secrets: Object.values(LANTERN_MARKERS),
  expected: {
    types: [
      { name: "drops", count: 2 },
      { name: "journal", count: 2 },
      { name: "top-level", count: 3 },
    ],
    published: {
      options: { types: ["journal", "drops"] },
      ids: [
        `${LANTERN}/journal/kiln-firing`,
        `${LANTERN}/journal/glaze-notes`,
        `${LANTERN}/drops/moonglaze-mugs`,
        `${LANTERN}/drops/ember-bowls`,
      ],
    },
    draftsReachable: "not-applicable",
  },
  // robots.txt and the sitemap are answered; the home page (looked at for feed links) is the first refused.
  rateLimit: { options: { types: ["journal", "drops"] }, succeedFirst: 2, atLeast: 4 },
};

/**
 * One entry for each hosted builder with no content API (adapters/builders.ts). All of them read the
 * same invented site, Tidewater Pop-Up (builders-fixture.ts): the adapters differ in their words, not in
 * what they request. No key, no fields, no drafts.
 */
export const builderEntries: readonly ContractEntry[] = BUILDERS.map((platform): ContractEntry => ({
  id: platform.id,
  make: ({ fetcher, sleep }) => createBuilderAdapter(platform, { fetcher, site: TIDEWATER, sleep }),
  transport: () => tidewaterServe(tidewaterRoutes()),
  secrets: Object.values(TIDEWATER_MARKERS),
  expected: {
    types: [
      { name: "blog", count: 1 },
      { name: "shop", count: 2 },
      { name: "top-level", count: 3 },
    ],
    published: {
      options: { types: ["blog", "shop"] },
      ids: [
        `${TIDEWATER}/shop/sea-glass-pendant`,
        `${TIDEWATER}/shop/driftwood-studs`,
        `${TIDEWATER}/blog/harbour-stall`,
      ],
    },
    draftsReachable: "not-applicable",
  },
  // robots.txt and the sitemap are answered; the home page (for feed links) is the first refused.
  rateLimit: { options: { types: ["blog", "shop"] }, succeedFirst: 2, atLeast: 3 },
}));

export const ENTRIES: readonly ContractEntry[] = [
  sanityEntry,
  sitemapFeedEntry,
  wordpressEntry,
  webflowEntry,
  framerEntry,
  ...builderEntries,
];
