import { testKey } from "../../connectors/__tests__/fake.js";
import { createContentstackAdapter } from "../contentstack.js";
import type { ContractEntry } from "./contract.js";
import { contentstackTransport, CONTENTSTACK_MARKERS } from "./contentstack-fixture.js";

/**
 * Harbour Lantern Inn: a boutique hotel on Contentstack, with rooms (one never published to the environment),
 * offers and team members (see contentstack-fixture.ts). The delivery token reads published entries only, so
 * the draft is never in an answer.
 */
const TOKEN = testKey("contentstack-delivery");
const API_KEY = testKey("contentstack-stack");

export const contentstackEntry: ContractEntry = {
  id: "contentstack",
  make: ({ fetcher, sleep }) =>
    createContentstackAdapter({
      env: {
        CONTENTSTACK_API_KEY: API_KEY,
        CONTENTSTACK_DELIVERY_TOKEN: TOKEN,
        CONTENTSTACK_ENVIRONMENT: "production",
      },
      fetcher,
      sleep,
    }),
  transport: () => contentstackTransport(undefined, { token: TOKEN, apiKey: API_KEY }),
  key: TOKEN,
  // The key travels in two headers and never as Authorization.
  keyHeaders: { access_token: TOKEN, api_key: API_KEY },
  unknownType: "could-not-check",
  secrets: [...Object.values(CONTENTSTACK_MARKERS), API_KEY],
  expected: {
    types: [
      { name: "offers", count: 1 },
      { name: "rooms", count: 2 },
      { name: "team", count: 2 },
    ],
    fields: {
      type: "rooms",
      counts: { title: 2, summary: 1 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["rooms"], fields: { rooms: ["title", "summary"] } },
      ids: ["blt0a1b2c3d4e5f0101", "blt0a1b2c3d4e5f0102"],
    },
    // A delivery token reads what is published to its environment and nothing else.
    draftsReachable: false,
  },
  // The content types and the first type's page are answered; the second type's page is the first refused.
  rateLimit: { options: { types: ["rooms", "team"] }, succeedFirst: 2, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [contentstackEntry];
