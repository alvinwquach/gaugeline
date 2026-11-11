import { testKey } from "../../connectors/__tests__/fake.js";
import { createContentstackAdapter } from "../contentstack.js";
import type { ContractEntry } from "./contract.js";
import { contentstackTransport, CONTENTSTACK_MARKERS } from "./contentstack-fixture.js";

/**
 * Larkspur Yoga Studio: a small studio on Contentstack, with classes (one a draft), notices and teachers (see
 * contentstack-fixture.ts). TODO(new:adapter) describe the invented site in terms of the platform.
 */
const CONTENTSTACK_KEY = testKey("contentstack-adapter");

export const contentstackEntry: ContractEntry = {
  id: "contentstack",
  make: ({ fetcher, sleep }) =>
    createContentstackAdapter({
      env: { CONTENTSTACK_TOKEN: CONTENTSTACK_KEY },
      fetcher,
      sleep,
    }),
  transport: () => contentstackTransport(undefined, { token: CONTENTSTACK_KEY }),
  key: CONTENTSTACK_KEY,
  secrets: Object.values(CONTENTSTACK_MARKERS),
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
export const contractEntries: readonly ContractEntry[] = [contentstackEntry];
