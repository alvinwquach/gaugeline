import { testKey } from "../../connectors/__tests__/fake.js";
import { createGenericApiAdapter } from "../generic-api.js";
import type { ContractEntry } from "./contract.js";
import { HERON_API, HERON_MARKERS, HERON_URLS, heronTransport } from "./generic-api-fixture.js";

/**
 * Heron Yoga Studio: a studio whose site reads three sources through one mapping: a Payload-style list
 * paged by number, a Directus-style list paged by offset (with one draft) and a GraphQL connection read
 * with GET and paged by cursor (see generic-api-fixture.ts). The key is the value of an environment
 * variable, sent as "Authorization: Bearer <key>".
 */
const HERON_KEY = testKey("generic-api");

export const genericApiEntry: ContractEntry = {
  id: "generic-api",
  make: ({ fetcher, sleep }) =>
    createGenericApiAdapter({
      env: { GAUGELINE_API_HERON_TOKEN: HERON_KEY },
      fetcher,
      sleep,
      settings: { id: "generic-api", api: HERON_API, urls: HERON_URLS },
    }),
  transport: () => heronTransport({ key: HERON_KEY }),
  key: HERON_KEY,
  secrets: Object.values(HERON_MARKERS),
  expected: {
    types: [
      { name: "class", count: 3 },
      { name: "post", count: 5 },
      { name: "workshop", count: 3 },
    ],
    fields: {
      type: "post",
      counts: { title: 5, summary: 4, "seo.title": 2 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["post"], fields: { post: ["title", "summary"] } },
      ids: ["p-1", "p-2", "p-3", "p-4", "p-5"],
    },
    draftsReachable: true,
  },
  // The classes' first page is answered; their second page is the first refused.
  rateLimit: { options: { types: ["class", "post"] }, succeedFirst: 1, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [genericApiEntry];
