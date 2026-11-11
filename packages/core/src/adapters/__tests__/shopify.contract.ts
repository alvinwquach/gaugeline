import { testKey } from "../../connectors/__tests__/fake.js";
import { createShopifyAdapter } from "../shopify.js";
import type { ContractEntry } from "./contract.js";
import { shopifyTransport, SHOPIFY_MARKERS } from "./shopify-fixture.js";

/**
 * Larkspur Yoga Studio: a small studio on Shopify, with classes (one a draft), notices and teachers (see
 * shopify-fixture.ts). TODO(new:adapter) describe the invented site in terms of the platform.
 */
const SHOPIFY_KEY = testKey("shopify-adapter");

export const shopifyEntry: ContractEntry = {
  id: "shopify",
  make: ({ fetcher, sleep }) =>
    createShopifyAdapter({
      env: { SHOPIFY_TOKEN: SHOPIFY_KEY },
      fetcher,
      sleep,
    }),
  transport: () => shopifyTransport(undefined, { token: SHOPIFY_KEY }),
  key: SHOPIFY_KEY,
  secrets: Object.values(SHOPIFY_MARKERS),
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
export const contractEntries: readonly ContractEntry[] = [shopifyEntry];
