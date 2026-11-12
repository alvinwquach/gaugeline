import { testKey } from "../../connectors/__tests__/fake.js";
import { createDatocmsAdapter, DATOCMS_CDA_QUERY } from "../datocms.js";
import type { ContractEntry } from "./contract.js";
import { datocmsTransport, DATOCMS_COLLECTIONS, DATOCMS_MARKERS } from "./datocms-fixture.js";

/**
 * Larkspur Yoga Studio: a small studio on DatoCMS, with classes (one a draft), notices and teachers (see
 * datocms-fixture.ts). The adapter asks the Content Delivery API's one endpoint with POSTed GraphQL queries, which
 * the registered allowlist entry (ADR-0006) is the only way to send.
 */
const DATOCMS_KEY = testKey("datocms-adapter");

export const datocmsEntry: ContractEntry = {
  id: "datocms",
  make: ({ fetcher, sleep }) =>
    createDatocmsAdapter({
      env: { DATOCMS_TOKEN: DATOCMS_KEY },
      fetcher,
      settings: { id: "datocms", collections: DATOCMS_COLLECTIONS },
      sleep,
    }),
  transport: () => datocmsTransport(undefined, { token: DATOCMS_KEY }),
  key: DATOCMS_KEY,
  queryAllow: [DATOCMS_CDA_QUERY],
  // The collections come from the settings, so a name the settings do not have is could-not-check, never an empty type.
  unknownType: "could-not-check",
  secrets: Object.values(DATOCMS_MARKERS),
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
      ids: ["1001", "1002"],
    },
    draftsReachable: true,
  },
  // The first collection's page is answered (two records); the next collection's request is the first refused.
  rateLimit: { options: { types: ["classes", "teachers"] }, succeedFirst: 1, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [datocmsEntry];
