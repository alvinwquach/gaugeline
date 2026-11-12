import { testKey } from "../../connectors/__tests__/fake.js";
import { createDirectusAdapter } from "../directus.js";
import type { ContractEntry } from "./contract.js";
import { CMS_URL, DIRECTUS_MARKERS, directusTransport } from "./directus-fixture.js";

/**
 * Larkspur Yoga Studio: a studio whose Directus holds classes (one a draft), notices, teachers and a private
 * appointments collection (see directus-fixture.ts). A static token on a read-only role; the unpublished class
 * is reachable with it. Directus lists no collections to the adapter, so the settings name them.
 */
const DIRECTUS_KEY = testKey("directus-adapter");

export const directusEntry: ContractEntry = {
  id: "directus",
  make: ({ fetcher, sleep }) =>
    createDirectusAdapter({
      env: { DIRECTUS_URL: CMS_URL, DIRECTUS_TOKEN: DIRECTUS_KEY },
      fetcher,
      sleep,
      settings: {
        id: "directus",
        urls: {
          classes: "/classes/{slug}",
          notices: "/notices/{slug}",
          teachers: "/teachers/{slug}",
        },
      },
    }),
  transport: () => directusTransport(undefined, { token: DIRECTUS_KEY }),
  key: DIRECTUS_KEY,
  secrets: Object.values(DIRECTUS_MARKERS),
  expected: {
    types: [
      { name: "classes", count: 2 },
      { name: "notices", count: 1 },
      { name: "teachers", count: 2 },
    ],
    fields: {
      type: "classes",
      counts: { name: 2, summary: 1, slug: 2 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["classes"], fields: { classes: ["name", "summary"] } },
      ids: ["1", "2"],
    },
    draftsReachable: true,
  },
  // The first collection's page is answered; the second's is the first refused.
  rateLimit: { options: { types: ["classes", "teachers"] }, succeedFirst: 1, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [directusEntry];
