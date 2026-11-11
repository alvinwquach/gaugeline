import { testKey } from "../../connectors/__tests__/fake.js";
import { createHubspotCmsAdapter } from "../hubspot-cms.js";
import type { ContractEntry } from "./contract.js";
import { hubspotCmsTransport, HUBSPOT_CMS_MARKERS } from "./hubspot-cms-fixture.js";

/**
 * Brass Whisk Bakehouse: a pop-up bakery on HubSpot CMS, with site pages (one a draft), landing pages, blog
 * posts and a HubDB table of loaves (see hubspot-cms-fixture.ts).
 */
const HUBSPOT_CMS_KEY = testKey("hubspot-cms-adapter");

export const hubspotCmsEntry: ContractEntry = {
  id: "hubspot-cms",
  make: ({ fetcher, sleep }) =>
    createHubspotCmsAdapter({
      env: { HUBSPOT_CMS_TOKEN: HUBSPOT_CMS_KEY },
      fetcher,
      sleep,
    }),
  transport: () => hubspotCmsTransport(undefined, { token: HUBSPOT_CMS_KEY }),
  key: HUBSPOT_CMS_KEY,
  unknownType: "could-not-check",
  secrets: Object.values(HUBSPOT_CMS_MARKERS),
  expected: {
    types: [
      { name: "blog-posts", count: 2 },
      { name: "hubdb.loaves", count: 3 },
      { name: "landing-pages", count: 2 },
      { name: "site-pages", count: 3 },
    ],
    fields: {
      type: "site-pages",
      counts: { name: 3, metaDescription: 2 },
      missing: "subtitle",
    },
    published: {
      options: {
        types: ["site-pages"],
        fields: { "site-pages": ["name", "metaDescription"] },
      },
      ids: ["101", "102", "103"],
    },
    draftsReachable: true,
  },
  // The first list answers; the second list's first page is the first one refused.
  rateLimit: { options: { types: ["site-pages", "blog-posts"] }, succeedFirst: 1, atLeast: 3 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [hubspotCmsEntry];
