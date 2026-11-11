import { createAemAdapter } from "../aem.js";
import type { ContractEntry } from "./contract.js";
import { aemTransport, AEM_ENV, AEM_MARKERS } from "./aem-fixture.js";

/**
 * Harbourline Hotels: a small hotel group on AEM Sites, with rooms (one a draft that the publish tier never
 * serves), offers and venues behind persisted queries (see aem-fixture.ts). No key: the publish tier is public.
 */
export const aemEntry: ContractEntry = {
  id: "aem",
  make: ({ fetcher, sleep }) =>
    createAemAdapter({
      env: AEM_ENV,
      fetcher,
      sleep,
      settings: {
        id: "aem",
        fingerprint: { rooms: ["name", "summary"] },
        urls: { rooms: "/rooms/{slug}", offers: "/offers/{slug}", venues: "/venues/{slug}" },
      },
    }),
  transport: () => aemTransport(),
  secrets: Object.values(AEM_MARKERS),
  unknownType: "could-not-check",
  expected: {
    types: [
      { name: "offers", count: 1 },
      { name: "rooms", count: 2 },
      { name: "venues", count: 2 },
    ],
    fields: {
      type: "rooms",
      counts: { name: 2, summary: 1 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["rooms"], fields: { rooms: ["name", "summary"] } },
      ids: ["harbourline.en.rooms.harbour-view", "harbourline.en.rooms.garden"],
    },
    draftsReachable: "not-applicable",
  },
  // The first page of "offers" is answered; the next query's first page is the first refused.
  rateLimit: { options: { types: ["offers", "rooms"] }, succeedFirst: 1, atLeast: 1 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [aemEntry];
