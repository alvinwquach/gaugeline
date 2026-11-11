import { testKey } from "../../connectors/__tests__/fake.js";
import { SITECORE_QUERY_ALLOW, createSitecoreAdapter } from "../sitecore.js";
import type { ContractEntry } from "./contract.js";
import { SITECORE_MARKERS, SITE_NAME, sitecoreTransport } from "./sitecore-fixture.js";

/**
 * Larkspur Yoga Studio: a small studio on Sitecore XM Cloud, one site (larkspur) in two languages (see
 * sitecore-fixture.ts). The Delivery API token reads what is published to Experience Edge and nothing else, so a
 * draft is never in an answer. The token goes in the sc_apikey header and is never an Authorization header.
 */
const SITECORE_KEY = testKey("sitecore-delivery");

export const SITECORE_SETTINGS = {
  id: "sitecore",
  siteName: SITE_NAME,
  languages: ["en", "fr-CA"],
  urls: { "fr-CA": "/fr-ca" },
};

export const sitecoreEntry: ContractEntry = {
  id: "sitecore",
  make: ({ fetcher, sleep }) =>
    createSitecoreAdapter({
      env: { SITECORE_API_KEY: SITECORE_KEY },
      fetcher,
      settings: SITECORE_SETTINGS,
      sleep,
    }),
  transport: () => sitecoreTransport(undefined, { token: SITECORE_KEY }),
  key: SITECORE_KEY,
  keyHeaders: { sc_apikey: SITECORE_KEY },
  queryAllow: [SITECORE_QUERY_ALLOW],
  secrets: Object.values(SITECORE_MARKERS),
  expected: {
    types: [
      { name: "en", count: 6 },
      { name: "fr-CA", count: 3 },
    ],
    // A route list has no fields: fieldCounts is could-not-check, not applicable.
    published: {
      options: { types: ["fr-CA"] },
      ids: ["fr-CA:/", "fr-CA:/classes", "fr-CA:/classes/morning-flow"],
    },
    draftsReachable: "not-applicable",
  },
  // The first language's list is answered; the second language's is the first refused.
  rateLimit: { options: { types: ["en", "fr-CA"] }, succeedFirst: 1, atLeast: 6 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [sitecoreEntry];
