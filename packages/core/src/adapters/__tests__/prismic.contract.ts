import { testKey } from "../../connectors/__tests__/fake.js";
import { createPrismicAdapter } from "../prismic.js";
import type { ContractEntry } from "./contract.js";
import { PRISMIC_MARKERS, REPOSITORY, prismicTransport } from "./prismic-fixture.js";

/**
 * Larkspur Yoga Studio: a studio whose public Prismic repository holds classes, notices and teachers, with an autumn
 * release (see prismic-fixture.ts). The repository is public, so the published reads carry no key at all; the
 * access token goes in an Authorization header, and only for what needs it (the releases).
 */
const PRISMIC_KEY = testKey("prismic-adapter");

export const prismicEntry: ContractEntry = {
  id: "prismic",
  make: ({ fetcher, sleep }) =>
    createPrismicAdapter({
      env: { PRISMIC_REPOSITORY: REPOSITORY, PRISMIC_ACCESS_TOKEN: PRISMIC_KEY },
      fetcher,
      sleep,
      settings: {
        id: "prismic",
        urls: { classes: "/classes/{slug}", teachers: "/teachers/{slug}" },
        checkReleases: true,
      },
    }),
  transport: () => prismicTransport(undefined, { releaseToken: PRISMIC_KEY }),
  key: PRISMIC_KEY,
  keyHeader: { value: `Token ${PRISMIC_KEY}` },
  secrets: Object.values(PRISMIC_MARKERS),
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
      ids: ["c-morning", "c-evening"],
    },
    draftsReachable: true,
  },
  // The root and the first type's page are answered; the second type's page is the first refused.
  rateLimit: { options: { types: ["classes", "teachers"] }, succeedFirst: 2, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [prismicEntry];
