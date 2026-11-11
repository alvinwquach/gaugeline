import { testKey } from "../../connectors/__tests__/fake.js";
import { createHubspotCmsAdapter } from "../hubspot-cms.js";
import type { ContractEntry } from "./contract.js";
import { hubspotCmsTransport, HUBSPOT_CMS_MARKERS } from "./hubspot-cms-fixture.js";

/**
 * Larkspur Yoga Studio: a small studio on HubSpot CMS, with classes (one a draft), notices and teachers (see
 * hubspot-cms-fixture.ts). TODO(new:adapter) describe the invented site in terms of the platform.
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
  secrets: Object.values(HUBSPOT_CMS_MARKERS),
  expected: {
    types: [
      { name: "classes", count: 2 },
      { name: "notices", count: 1 },
      { name: "teachers", count: 2 },
    ],
    fields: {
      type: "classes",
      counts: { name: 2, summary: 1 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["classes"], fields: { classes: ["name", "summary"] } },
      ids: ["c-morning", "c-evening"],
    },
    draftsReachable: true,
  },
  // The types and the first type's page are answered; the second type's page is the first refused.
  rateLimit: { options: { types: ["classes", "teachers"] }, succeedFirst: 2, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [hubspotCmsEntry];
