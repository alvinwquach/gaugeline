// check-community: allow-email (invented addresses at reserved example domains, for the members fixture)
import { createWixAdapter } from "../wix.js";
import type { ContractEntry } from "./contract.js";
import { MARLOW, MARLOW_MARKERS, marlowRoutes, marlowServe } from "./wix-fixture.js";

/**
 * Marlow Coaching: a career coach on Wix. The live site's sitemap is all Gaugeline can read: Wix's CMS items are
 * behind a POST query (Query Data Items), which Gaugeline never sends, so there are no fields, no key and no
 * drafts (see wix-fixture.ts).
 */
export const wixEntry: ContractEntry = {
  id: "wix",
  make: ({ fetcher, sleep }) => createWixAdapter({ fetcher, site: MARLOW, sleep }),
  transport: () => marlowServe(marlowRoutes()),
  secrets: Object.values(MARLOW_MARKERS),
  expected: {
    types: [
      { name: "post", count: 3 },
      { name: "programs", count: 2 },
      { name: "top-level", count: 3 },
    ],
    published: {
      options: { types: ["programs", "post"] },
      ids: [
        `${MARLOW}/post/ninety-day-plan`,
        `${MARLOW}/post/salary-first-call`,
        `${MARLOW}/post/sunday-dread`,
        `${MARLOW}/programs/spring-cohort`,
        `${MARLOW}/programs/one-to-one`,
      ],
    },
    draftsReachable: "not-applicable",
  },
  // robots.txt, the index, the pages sitemap and the blog sitemap are answered; the programs sitemap is the first refused.
  rateLimit: { options: { types: ["post", "top-level"] }, succeedFirst: 4, atLeast: 6 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [wixEntry];
