import { testKey } from "../../connectors/__tests__/fake.js";
import { createCraftAdapter } from "../craft.js";
import type { ContractEntry } from "./contract.js";
import { craftTransport, CRAFT_MARKERS } from "./craft-fixture.js";

/**
 * Larkspur Yoga Studio: a small studio on Craft CMS, with classes (one a draft), notices and teachers (see
 * craft-fixture.ts). TODO(new:adapter) describe the invented site in terms of the platform.
 */
const CRAFT_KEY = testKey("craft-adapter");

export const craftEntry: ContractEntry = {
  id: "craft",
  make: ({ fetcher, sleep }) =>
    createCraftAdapter({
      env: { CRAFT_TOKEN: CRAFT_KEY },
      fetcher,
      sleep,
    }),
  transport: () => craftTransport(undefined, { token: CRAFT_KEY }),
  key: CRAFT_KEY,
  secrets: Object.values(CRAFT_MARKERS),
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
export const contractEntries: readonly ContractEntry[] = [craftEntry];
