import { testKey } from "../../connectors/__tests__/fake.js";
import { createContentfulAdapter } from "../contentful.js";
import type { ContractEntry } from "./contract.js";
import { CONTENTFUL_MARKERS, SPACE_ID, contentfulTransport } from "./contentful-fixture.js";

/**
 * Ash & Ember Taproom: a bar's Contentful space with beers, events and testimonials, and one event saved
 * and not published (see contentful-fixture.ts). A delivery token only: it can read what is published and
 * nothing else, so no unpublished work is reachable.
 */
const CONTENTFUL_KEY = testKey("contentful-adapter");

export const contentfulEntry: ContractEntry = {
  id: "contentful",
  make: ({ fetcher, sleep }) =>
    createContentfulAdapter({
      env: { CONTENTFUL_SPACE_ID: SPACE_ID, CONTENTFUL_DELIVERY_TOKEN: CONTENTFUL_KEY },
      fetcher,
      sleep,
    }),
  transport: () => contentfulTransport(undefined, { token: CONTENTFUL_KEY }),
  key: CONTENTFUL_KEY,
  // The space lists its content types, so a name that is not one is a mistake, not an empty type.
  unknownType: "could-not-check",
  secrets: Object.values(CONTENTFUL_MARKERS),
  expected: {
    types: [
      { name: "beer", count: 3 },
      { name: "event", count: 2 },
      { name: "testimonial", count: 2 },
    ],
    fields: {
      type: "event",
      counts: { title: 2, summary: 1, slug: 2 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["event"], fields: { event: ["title", "summary"] } },
      ids: ["ev-trivia", "ev-dinner"],
    },
    draftsReachable: false,
  },
  // The content types and the beers' page are answered; the events' page is the first refused.
  rateLimit: { options: { types: ["beer", "event"] }, succeedFirst: 2, atLeast: 3 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [contentfulEntry];
