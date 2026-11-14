import { testKey } from "../../connectors/__tests__/fake.js";
import { createPayloadAdapter } from "../payload.js";
import type { ContractEntry } from "./contract.js";
import { API_URL, PAYLOAD_MARKERS, payloadTransport } from "./payload-fixture.js";

/**
 * Quillon Coffee Roasters: a roastery whose Payload holds posts (one a draft), events and a private collection of
 * wholesale orders (see payload-fixture.ts). An API key on a read-only user; the draft post is reachable with it.
 * Payload lists no collections to the adapter, so the settings name them.
 */
const PAYLOAD_KEY = testKey("payload-adapter");

export const payloadEntry: ContractEntry = {
  id: "payload",
  make: ({ fetcher, sleep }) =>
    createPayloadAdapter({
      env: { PAYLOAD_URL: API_URL, PAYLOAD_API_KEY: PAYLOAD_KEY },
      fetcher,
      sleep,
      settings: {
        id: "payload",
        urls: { posts: "/journal/{slug}", events: "/events/{slug}" },
      },
    }),
  transport: () => payloadTransport(undefined, { key: PAYLOAD_KEY }),
  key: PAYLOAD_KEY,
  // Payload sends the key as "<auth collection> API-Key <key>", not as a bearer token.
  keyPrefix: "users API-Key ",
  secrets: Object.values(PAYLOAD_MARKERS),
  expected: {
    types: [
      { name: "events", count: 2 },
      { name: "posts", count: 2 },
    ],
    fields: {
      type: "posts",
      counts: { title: 2, summary: 1, slug: 2 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["posts"], fields: { posts: ["title", "summary"] } },
      ids: ["6650a1c0", "6650a1c1"],
    },
    draftsReachable: true,
  },
  // The first collection's page is answered; the second's is the first refused.
  rateLimit: { options: { types: ["events", "posts"] }, succeedFirst: 1, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [payloadEntry];
