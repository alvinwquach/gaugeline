import { testKey } from "../../connectors/__tests__/fake.js";
import { createSquarespaceCommerceAdapter } from "../squarespace-commerce.js";
import type { ContractEntry } from "./contract.js";
import {
  squarespaceCommerceTransport,
  SQUARESPACE_COMMERCE_MARKERS,
} from "./squarespace-commerce-fixture.js";

/**
 * Tideline Print Shop: a pop-up shop on Squarespace with four products, one of them hidden (a draft), read
 * two to a page by cursor (see squarespace-commerce-fixture.ts).
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
  // The adapter has one type, so a name it does not have is could-not-check, not a count of zero.
  unknownType: "could-not-check",
  secrets: Object.values(SQUARESPACE_COMMERCE_MARKERS),
  expected: {
    types: [{ name: "products", count: 3 }],
    fields: {
      type: "products",
      counts: { name: 3, description: 2 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["products"], fields: { products: ["name", "description"] } },
      ids: ["p-dawn", "p-tote", "p-zine"],
    },
    draftsReachable: true,
  },
  // The first products page (two items) is answered; the second page is the first refused.
  rateLimit: { options: { types: ["products"] }, succeedFirst: 1, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [squarespaceCommerceEntry];
