import { testKey } from "../../connectors/__tests__/fake.js";
import { createShopifyAdapter, SHOPIFY_STOREFRONT_QUERY } from "../shopify.js";
import type { ContractEntry } from "./contract.js";
import { SHOPIFY_SHOP, shopifyTransport, SHOPIFY_MARKERS } from "./shopify-fixture.js";

/**
 * Larkspur Ceramics: a small studio store on Shopify, with products (one hidden from the Online Store),
 * collections, pages, a blog and an article (see shopify-fixture.ts).
 */
const SHOPIFY_KEY = testKey("shopify-adapter");

export const shopifyEntry: ContractEntry = {
  id: "shopify",
  make: ({ fetcher, sleep }) =>
    createShopifyAdapter({
      env: { SHOPIFY_STOREFRONT_TOKEN: SHOPIFY_KEY, SHOPIFY_SHOP_DOMAIN: SHOPIFY_SHOP },
      fetcher,
      sleep,
    }),
  transport: () => shopifyTransport(undefined, { token: SHOPIFY_KEY }),
  key: SHOPIFY_KEY,
  // The Storefront API reads its token from this header, not from Authorization.
  keyHeaders: { "x-shopify-storefront-access-token": SHOPIFY_KEY },
  queryAllow: [SHOPIFY_STOREFRONT_QUERY],
  queryHosts: { [SHOPIFY_STOREFRONT_QUERY.id]: SHOPIFY_SHOP },
  secrets: Object.values(SHOPIFY_MARKERS),
  expected: {
    types: [
      { name: "articles", count: 1 },
      { name: "blogs", count: 1 },
      { name: "collections", count: 2 },
      { name: "pages", count: 2 },
      { name: "products", count: 2 },
    ],
    fields: {
      type: "products",
      counts: { title: 2, description: 1 },
      // A field Shopify allows for products that no invented product has: counted as 0, not an error.
      missing: "vendor",
    },
    published: {
      options: { types: ["products"], fields: { products: ["title", "description"] } },
      ids: ["1001", "1002"],
    },
    draftsReachable: false,
  },
  // A field outside the type's own list, and a type Shopify does not have, are could-not-check (never zeros).
  unknownType: "could-not-check",
  // The pages are answered, then the products are the first refused.
  rateLimit: { options: { types: ["pages", "products"] }, succeedFirst: 1, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [shopifyEntry];
