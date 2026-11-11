import { testKey } from "../../connectors/__tests__/fake.js";
import { WIX_QUERY_ALLOW, createWixAdapter } from "../wix.js";
import type { ContractEntry } from "./contract.js";
import { MARLOW_SITE_ID, WIX_NATIVE_MARKERS, wixTransport } from "./wix-native-fixture.js";

/**
 * Marlow Coaching: a career coach on Wix, read through Wix Data's Query Data Items with an API key that may only
 * read (the one POST, ADR-0006; see wix-native-fixture.ts). The live-site read with no key (the sitemap) has its
 * own tests in wix.test.ts. Wix lists no collections to the adapter, so the settings name them. The key is the
 * whole Authorization header value.
 */
const WIX_KEY = testKey("wix-api");

export const wixEntry: ContractEntry = {
  id: "wix",
  make: ({ fetcher, sleep }) =>
    createWixAdapter({
      env: { WIX_API_KEY: WIX_KEY },
      fetcher,
      sleep,
      // Two items to a page, so a collection of three is read across two requests.
      pageSize: 2,
      settings: {
        id: "wix",
        siteId: MARLOW_SITE_ID,
        urls: { Programs: "/programs/{slug}", Testimonials: "/testimonials/{id}" },
      },
    }),
  transport: () => wixTransport({ key: WIX_KEY }),
  key: WIX_KEY,
  keyRaw: true,
  queryAllow: [WIX_QUERY_ALLOW],
  secrets: Object.values(WIX_NATIVE_MARKERS),
  expected: {
    types: [
      { name: "Programs", count: 3 },
      { name: "Testimonials", count: 2 },
    ],
    fields: {
      type: "Programs",
      counts: { title: 3, blurb: 1, slug: 3 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["Programs"], fields: { Programs: ["title", "blurb"] } },
      ids: ["prog-spring-cohort", "prog-one-to-one", "prog-summer-intensive"],
    },
    draftsReachable: "not-applicable",
  },
  // Programs is read in two requests; the Testimonials request is the first refused.
  rateLimit: { options: { types: ["Programs", "Testimonials"] }, succeedFirst: 2, atLeast: 3 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [wixEntry];
