import { testKey } from "../../connectors/__tests__/fake.js";
import { createGitContentAdapter } from "../git-content.js";
import type { ContractEntry } from "./contract.js";
import {
  ASTRO_FILES,
  ASTRO_FOLDERS,
  CONTENT_MARKERS as GIT_MARKERS,
  NOW,
  REPO,
  githubTransport,
} from "./git-content-fixture.js";

/**
 * Nettle & Thread's Astro site, read from GitHub with a fine-grained token: a blog collection (one
 * draft, one scheduled post, one underscore file that is not content) and stalls kept as YAML. The
 * local-folder source has its own tests (git-content-adapter.test.ts): it makes no request, which this
 * suite is about.
 */
const GIT_KEY = testKey("git-content-adapter");

export const gitContentEntry: ContractEntry = {
  id: "git-content",
  make: ({ fetcher, sleep }) =>
    createGitContentAdapter({
      env: { GAUGELINE_GITHUB_TOKEN: GIT_KEY },
      fetcher,
      sleep,
      now: () => NOW,
      settings: { id: "git-content", github: { repo: REPO }, folders: ASTRO_FOLDERS },
    }),
  transport: () => githubTransport(ASTRO_FILES, { token: GIT_KEY }),
  key: GIT_KEY,
  secrets: Object.values(GIT_MARKERS),
  expected: {
    types: [
      { name: "blog", count: 3 },
      { name: "stalls", count: 2 },
    ],
    fields: {
      type: "blog",
      counts: { title: 3, description: 2, slug: 1 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["blog"], fields: { blog: ["title", "description"] } },
      ids: [
        "src/content/blog/second-hand-swap.mdx",
        "src/content/blog/spring-market.md",
        "src/content/blog/workshop-dates.md",
      ],
    },
    draftsReachable: "not-applicable",
  },
  // The tree and the first three files (the draft, the scheduled post, the swap) are answered; the next is refused.
  rateLimit: { options: { types: ["blog"] }, succeedFirst: 4, atLeast: 1, alsoAs403: true },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [gitContentEntry];
