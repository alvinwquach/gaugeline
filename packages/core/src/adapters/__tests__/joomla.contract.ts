import { testKey } from "../../connectors/__tests__/fake.js";
import { createJoomlaAdapter } from "../joomla.js";
import type { ContractEntry } from "./contract.js";
import { joomlaTransport, JOOMLA_MARKERS } from "./joomla-fixture.js";

/**
 * Larkspur Yoga Studio: a small studio on Joomla, with classes (one a draft), notices and teachers (see
 * joomla-fixture.ts). TODO(new:adapter) describe the invented site in terms of the platform.
 */
const JOOMLA_KEY = testKey("joomla-adapter");

export const joomlaEntry: ContractEntry = {
  id: "joomla",
  make: ({ fetcher, sleep }) =>
    createJoomlaAdapter({
      env: { JOOMLA_TOKEN: JOOMLA_KEY },
      fetcher,
      sleep,
    }),
  transport: () => joomlaTransport(undefined, { token: JOOMLA_KEY }),
  key: JOOMLA_KEY,
  secrets: Object.values(JOOMLA_MARKERS),
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
export const contractEntries: readonly ContractEntry[] = [joomlaEntry];
