import { createFramerAdapter } from "../framer.js";
import type { ContractEntry } from "./contract.js";
import { LANTERN, LANTERN_MARKERS, lanternRoutes, lanternServe } from "./framer-fixture.js";

/**
 * Lantern Row: a ceramics pop-up on Framer. The live site's sitemap is all Gaugeline can read: Framer's
 * CMS collections are behind the Server API (a WebSocket library, a key that can also change the
 * project), so there are no fields, no key and no drafts (see framer-fixture.ts).
 */
export const framerEntry: ContractEntry = {
  id: "framer",
  make: ({ fetcher, sleep }) => createFramerAdapter({ fetcher, site: LANTERN, sleep }),
  transport: () => lanternServe(lanternRoutes()),
  secrets: Object.values(LANTERN_MARKERS),
  expected: {
    types: [
      { name: "drops", count: 2 },
      { name: "journal", count: 2 },
      { name: "top-level", count: 3 },
    ],
    published: {
      options: { types: ["journal", "drops"] },
      ids: [
        `${LANTERN}/journal/kiln-firing`,
        `${LANTERN}/journal/glaze-notes`,
        `${LANTERN}/drops/moonglaze-mugs`,
        `${LANTERN}/drops/ember-bowls`,
      ],
    },
    draftsReachable: "not-applicable",
  },
  // robots.txt and the sitemap are answered; the home page (looked at for feed links) is the first refused.
  rateLimit: { options: { types: ["journal", "drops"] }, succeedFirst: 2, atLeast: 4 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [framerEntry];
