import { testKey } from "../../connectors/__tests__/fake.js";
import { createWebflowAdapter } from "../webflow.js";
import type { ContractEntry } from "./contract.js";
import { SITE_ID, WEBFLOW_MARKERS, webflowTransport } from "./webflow-fixture.js";

/**
 * Saltmarsh Supper Club: a Webflow site with events, menu items and testimonials, one event staged and
 * never published, one a draft, one archived, and a menu item with a later edit not yet published (see
 * webflow-fixture.ts). A token with read scopes; the unpublished work is reachable.
 */
const WEBFLOW_KEY = testKey("webflow-adapter");

export const webflowEntry: ContractEntry = {
  id: "webflow",
  make: ({ fetcher, sleep }) =>
    createWebflowAdapter({
      env: { WEBFLOW_TOKEN: WEBFLOW_KEY, WEBFLOW_SITE_ID: SITE_ID },
      fetcher,
      sleep,
    }),
  transport: () => webflowTransport(undefined, { token: WEBFLOW_KEY }),
  key: WEBFLOW_KEY,
  secrets: Object.values(WEBFLOW_MARKERS),
  expected: {
    types: [
      { name: "events", count: 2 },
      { name: "menu-items", count: 2 },
      { name: "testimonials", count: 2 },
    ],
    fields: {
      type: "events",
      counts: { name: 2, summary: 1, slug: 2 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["events"], fields: { events: ["name", "summary"] } },
      ids: ["e-harvest", "e-oyster"],
    },
    draftsReachable: true,
  },
  // The collections and the first events page are answered; the menu items' page is the first refused.
  rateLimit: { options: { types: ["events", "menu-items"] }, succeedFirst: 2, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [webflowEntry];
