import { BUILDERS, createBuilderAdapter } from "../builders.js";
import {
  TIDEWATER,
  TIDEWATER_MARKERS,
  tidewaterRoutes,
  tidewaterServe,
} from "./builders-fixture.js";
import type { ContractEntry } from "./contract.js";

/**
 * One entry for each hosted builder with no content API (adapters/builders.ts). All of them read the
 * same invented site, Tidewater Pop-Up (builders-fixture.ts): the adapters differ in their words, not in
 * what they request. No key, no fields, no drafts.
 */
export const builderEntries: readonly ContractEntry[] = BUILDERS.map((platform): ContractEntry => ({
  id: platform.id,
  make: ({ fetcher, sleep }) => createBuilderAdapter(platform, { fetcher, site: TIDEWATER, sleep }),
  transport: () => tidewaterServe(tidewaterRoutes()),
  secrets: Object.values(TIDEWATER_MARKERS),
  expected: {
    types: [
      { name: "blog", count: 1 },
      { name: "shop", count: 2 },
      { name: "top-level", count: 3 },
    ],
    published: {
      options: { types: ["blog", "shop"] },
      ids: [
        `${TIDEWATER}/shop/sea-glass-pendant`,
        `${TIDEWATER}/shop/driftwood-studs`,
        `${TIDEWATER}/blog/harbour-stall`,
      ],
    },
    draftsReachable: "not-applicable",
  },
  // robots.txt and the sitemap are answered; the home page (for feed links) is the first refused.
  rateLimit: { options: { types: ["blog", "shop"] }, succeedFirst: 2, atLeast: 3 },
}));

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [...builderEntries];
