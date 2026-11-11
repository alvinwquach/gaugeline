import { testKey } from "../../connectors/__tests__/fake.js";
import { createStrapiAdapter } from "../strapi.js";
import type { ContractEntry } from "./contract.js";
import { CMS_URL, STRAPI_MARKERS, strapiTransport } from "./strapi-fixture.js";

/**
 * Brass Anchor Taproom: a bar whose Strapi holds events, menu items and reviews, one event never
 * published (see strapi-fixture.ts). A read-only API token; the unpublished work is reachable with it.
 * Strapi lists no collections to a token, so the settings name them.
 */
const STRAPI_KEY = testKey("strapi-adapter");

export const strapiEntry: ContractEntry = {
  id: "strapi",
  make: ({ fetcher, sleep }) =>
    createStrapiAdapter({
      env: { STRAPI_URL: CMS_URL, STRAPI_TOKEN: STRAPI_KEY },
      fetcher,
      sleep,
      settings: {
        id: "strapi",
        urls: {
          events: "/events/{slug}",
          "menu-items": "/menu/{slug}",
          reviews: "/reviews/{slug}",
        },
      },
    }),
  transport: () => strapiTransport(undefined, { token: STRAPI_KEY }),
  key: STRAPI_KEY,
  secrets: Object.values(STRAPI_MARKERS),
  expected: {
    types: [
      { name: "events", count: 2 },
      { name: "menu-items", count: 2 },
      { name: "reviews", count: 2 },
    ],
    fields: {
      type: "events",
      counts: { title: 2, blurb: 1, slug: 2 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["events"], fields: { events: ["title", "blurb"] } },
      ids: ["evt-harvest", "evt-quiz"],
    },
    draftsReachable: true,
  },
  // The first events page is answered; the menu items' page is the first refused.
  rateLimit: { options: { types: ["events", "menu-items"] }, succeedFirst: 1, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [strapiEntry];
