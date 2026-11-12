import { testKey } from "../../connectors/__tests__/fake.js";
import { createHygraphAdapter, HYGRAPH_API_QUERY, HYGRAPH_CDN_QUERY } from "../hygraph.js";
import type { ContractEntry } from "./contract.js";
import {
  HYGRAPH_COLLECTIONS,
  HYGRAPH_HOST,
  HYGRAPH_MARKERS,
  HYGRAPH_URL,
  hygraphTransport,
} from "./hygraph-fixture.js";

/**
 * Pennywhistle Bakehouse: a pop-up bakery on Hygraph, with pages (one not published) and events (see
 * hygraph-fixture.ts). The adapter asks the project's one Content API endpoint with POSTed GraphQL queries, which
 * the registered allowlist entries (ADR-0006) are the only way to send; the host is the one HYGRAPH_ENDPOINT names.
 */
const HYGRAPH_KEY = testKey("hygraph-adapter");

export const hygraphEntry: ContractEntry = {
  id: "hygraph",
  make: ({ fetcher, sleep }) =>
    createHygraphAdapter({
      env: { HYGRAPH_TOKEN: HYGRAPH_KEY, HYGRAPH_ENDPOINT: HYGRAPH_URL },
      fetcher,
      settings: { id: "hygraph", collections: HYGRAPH_COLLECTIONS },
      sleep,
    }),
  transport: () => hygraphTransport(undefined, { token: HYGRAPH_KEY }),
  key: HYGRAPH_KEY,
  queryAllow: [HYGRAPH_API_QUERY, HYGRAPH_CDN_QUERY],
  queryHosts: { [HYGRAPH_API_QUERY.id]: HYGRAPH_HOST, [HYGRAPH_CDN_QUERY.id]: HYGRAPH_HOST },
  // The models come from the settings, so a name the settings do not have is could-not-check, never an empty type.
  unknownType: "could-not-check",
  secrets: Object.values(HYGRAPH_MARKERS),
  expected: {
    types: [
      { name: "events", count: 2 },
      { name: "pages", count: 2 },
    ],
    fields: {
      type: "pages",
      counts: { title: 2, summary: 1 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["pages"], fields: { pages: ["title", "summary"] } },
      ids: ["cm1page000000000home001", "cm1page000000000menu002"],
    },
    // Only the PUBLISHED stage is ever asked for by the shared reads.
    draftsReachable: "not-applicable",
  },
  // The first model's page is answered (two entries); the next model's request is the first refused.
  rateLimit: { options: { types: ["events", "pages"] }, succeedFirst: 1, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [hygraphEntry];
