import { testKey } from "../../connectors/__tests__/fake.js";
import { createSquarespaceCommerceAdapter } from "../squarespace-commerce.js";
import type { ContractEntry } from "./contract.js";
import {
  squarespaceCommerceTransport,
  SQUARESPACE_COMMERCE_MARKERS,
} from "./squarespace-commerce-fixture.js";

/**
 * Larkspur Yoga Studio: a small studio on Squarespace commerce, with classes (one a draft), notices and teachers (see
 * squarespace-commerce-fixture.ts). TODO(new:adapter) describe the invented site in terms of the platform.
 */
const SQUARESPACE_COMMERCE_KEY = testKey("squarespace-commerce-adapter");

export const squarespaceCommerceEntry: ContractEntry = {
  id: "squarespace-commerce",
  make: ({ fetcher, sleep }) =>
    createSquarespaceCommerceAdapter({
      env: { SQUARESPACE_COMMERCE_TOKEN: SQUARESPACE_COMMERCE_KEY },
      fetcher,
      sleep,
    }),
  transport: () => squarespaceCommerceTransport(undefined, { token: SQUARESPACE_COMMERCE_KEY }),
  key: SQUARESPACE_COMMERCE_KEY,
  secrets: Object.values(SQUARESPACE_COMMERCE_MARKERS),
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
export const contractEntries: readonly ContractEntry[] = [squarespaceCommerceEntry];
