import { testKey } from "../../connectors/__tests__/fake.js";
import { createTinaAdapter } from "../tina.js";
import type { ContractEntry } from "./contract.js";
import { REPO, githubTransport } from "./git-content-fixture.js";
import { TINA_FILES, TINA_MARKERS, TINA_NOW } from "./tina-fixture.js";

/**
 * Rye & Ember Bakery's Next.js site on TinaCMS, read from GitHub with a fine-grained token: tina/config.ts
 * names three collections (news posts with one draft, bread with a custom address and a folder left out by
 * `match`, and two JSON pages picked out by `match`). The local-folder source has its own tests
 * (tina-adapter.test.ts): it makes no request, which this suite is about.
 */
const TINA_KEY = testKey("tina-adapter");

export const tinaEntry: ContractEntry = {
  id: "tina",
  make: ({ fetcher, sleep }) =>
    createTinaAdapter({
      env: { GAUGELINE_GITHUB_TOKEN: TINA_KEY },
      fetcher,
      sleep,
      now: () => TINA_NOW,
      settings: { id: "tina", github: { repo: REPO } },
    }),
  transport: () => githubTransport(TINA_FILES, { token: TINA_KEY }),
  key: TINA_KEY,
  secrets: Object.values(TINA_MARKERS),
  expected: {
    types: [
      { name: "bread", count: 2 },
      { name: "page", count: 2 },
      { name: "post", count: 2 },
    ],
    fields: {
      type: "bread",
      counts: { title: 2, slug: 1 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["post"], fields: { post: ["title", "summary"] } },
      ids: ["content/posts/saturday-hours.mdx", "content/posts/sourdough-class.mdx"],
    },
    draftsReachable: "not-applicable",
  },
  // The tree, tina/config.ts, the draft and the first post are answered; the next file is the first refused.
  rateLimit: { options: { types: ["post"] }, succeedFirst: 4, atLeast: 1, alsoAs403: true },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [tinaEntry];
