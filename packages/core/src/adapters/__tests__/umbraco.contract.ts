import { testKey } from "../../connectors/__tests__/fake.js";
import { createUmbracoAdapter } from "../umbraco.js";
import type { ContractEntry } from "./contract.js";
import { umbracoTransport, UMBRACO_MARKERS, UMBRACO_SITE } from "./umbraco-fixture.js";

/**
 * Marigold Lane Community Theatre: a volunteer theatre on Umbraco, with shows (one a draft), news and cast
 * members (see umbraco-fixture.ts). The Delivery API is protected, so every request carries the key in the
 * `Api-Key` header; the unpublished show is reachable with it. The API lists no content types, so the settings name them.
 */
const UMBRACO_KEY = testKey("umbraco-adapter");

export const umbracoEntry: ContractEntry = {
  id: "umbraco",
  make: ({ fetcher, sleep }) =>
    createUmbracoAdapter({
      env: { UMBRACO_URL: UMBRACO_SITE, UMBRACO_API_KEY: UMBRACO_KEY },
      fetcher,
      sleep,
      settings: {
        id: "umbraco",
        urls: {
          show: "/whats-on/{slug}",
          notice: "/news/{slug}",
          castMember: "/company/{slug}",
        },
      },
    }),
  transport: () => umbracoTransport(undefined, { apiKey: UMBRACO_KEY, protectedApi: true }),
  key: UMBRACO_KEY,
  keyHeaderName: "api-key",
  secrets: Object.values(UMBRACO_MARKERS),
  expected: {
    types: [
      { name: "castMember", count: 2 },
      { name: "notice", count: 1 },
      { name: "show", count: 2 },
    ],
    fields: {
      type: "show",
      counts: { title: 2, blurb: 1 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["show"], fields: { show: ["title", "blurb"] } },
      ids: ["3f6c8a10-5b7e-4c21-9d34-a1b2c3d4e5f6", "7a1e9b52-0c3d-4f68-8e47-b2c3d4e5f6a7"],
    },
    draftsReachable: true,
  },
  // The first show page is answered; the second type's page is the first refused.
  rateLimit: { options: { types: ["show", "castMember"] }, succeedFirst: 1, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [umbracoEntry];
