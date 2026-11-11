import { createTinaAdapter } from "../tina.js";
import type { ContractEntry } from "./contract.js";
import { tinaTransport, TINA_MARKERS } from "./tina-fixture.js";

/**
 * Larkspur Yoga Studio: a small studio on TinaCMS, with classes (one a draft), notices and teachers (see
 * tina-fixture.ts). TODO(new:adapter) describe the invented site in terms of the platform.
 */
export const tinaEntry: ContractEntry = {
  id: "tina",
  make: ({ fetcher, sleep }) =>
    createTinaAdapter({
      env: {},
      fetcher,
      sleep,
    }),
  transport: () => tinaTransport(),
  secrets: Object.values(TINA_MARKERS),
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
    draftsReachable: "not-applicable",
  },
  // The types and the first type's page are answered; the second type's page is the first refused.
  rateLimit: { options: { types: ["classes", "teachers"] }, succeedFirst: 2, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [tinaEntry];
