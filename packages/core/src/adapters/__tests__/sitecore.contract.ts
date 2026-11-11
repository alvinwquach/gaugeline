import { testKey } from "../../connectors/__tests__/fake.js";
import { createSitecoreAdapter } from "../sitecore.js";
import type { ContractEntry } from "./contract.js";
import { sitecoreTransport, SITECORE_MARKERS } from "./sitecore-fixture.js";

/**
 * Larkspur Yoga Studio: a small studio on Sitecore XM Cloud, with classes (one a draft), notices and teachers (see
 * sitecore-fixture.ts). TODO(new:adapter) describe the invented site in terms of the platform.
 */
const SITECORE_KEY = testKey("sitecore-adapter");

export const sitecoreEntry: ContractEntry = {
  id: "sitecore",
  make: ({ fetcher, sleep }) =>
    createSitecoreAdapter({
      env: { SITECORE_TOKEN: SITECORE_KEY },
      fetcher,
      sleep,
    }),
  transport: () => sitecoreTransport(undefined, { token: SITECORE_KEY }),
  key: SITECORE_KEY,
  secrets: Object.values(SITECORE_MARKERS),
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
export const contractEntries: readonly ContractEntry[] = [sitecoreEntry];
