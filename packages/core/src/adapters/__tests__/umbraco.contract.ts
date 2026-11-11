import { testKey } from "../../connectors/__tests__/fake.js";
import { createUmbracoAdapter } from "../umbraco.js";
import type { ContractEntry } from "./contract.js";
import { umbracoTransport, UMBRACO_MARKERS } from "./umbraco-fixture.js";

/**
 * Larkspur Yoga Studio: a small studio on Umbraco, with classes (one a draft), notices and teachers (see
 * umbraco-fixture.ts). TODO(new:adapter) describe the invented site in terms of the platform.
 */
const UMBRACO_KEY = testKey("umbraco-adapter");

export const umbracoEntry: ContractEntry = {
  id: "umbraco",
  make: ({ fetcher, sleep }) =>
    createUmbracoAdapter({
      env: { UMBRACO_TOKEN: UMBRACO_KEY },
      fetcher,
      sleep,
    }),
  transport: () => umbracoTransport(undefined, { token: UMBRACO_KEY }),
  key: UMBRACO_KEY,
  secrets: Object.values(UMBRACO_MARKERS),
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
export const contractEntries: readonly ContractEntry[] = [umbracoEntry];
