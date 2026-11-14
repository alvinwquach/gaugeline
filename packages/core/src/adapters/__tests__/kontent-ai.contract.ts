import { testKey } from "../../connectors/__tests__/fake.js";
import { createKontentAdapter } from "../kontent-ai.js";
import type { ContractEntry } from "./contract.js";
import {
  ENVIRONMENT_ID,
  FERNHILL,
  KONTENT_MARKERS,
  kontentTransport,
  type KontentFixtureItem,
} from "./kontent-ai-fixture.js";

/**
 * Fernhill Cycles: a bike shop whose Kontent.ai environment holds journal articles and offers, some of them not
 * published (see kontent-ai-fixture.ts). The project is secured, so the Delivery API needs a secure access key, sent as
 * a bearer header. The contract fixture holds five published items and is read two at a time, so a read has several
 * pages to cut short.
 */
const SECURE_KEY = testKey("kontent-secure");

const PUBLISHED_EXTRA: KontentFixtureItem[] = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    type: "article",
    codename: "bike_fit",
    step: "published",
    published: true,
    modified: "2026-10-12T09:00:00Z",
    elements: {
      title: { type: "text", value: "A bike fit, step by step" },
      url: { type: "url_slug", value: "bike-fit" },
    },
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    type: "offer",
    codename: "kids_bikes",
    step: "published",
    published: true,
    modified: "2026-10-14T09:00:00Z",
    elements: {
      title: { type: "text", value: "Kids bikes, trade-in offer" },
      url: { type: "url_slug", value: "kids-bikes" },
    },
  },
];

export const kontentEntry: ContractEntry = {
  id: "kontent-ai",
  make: ({ fetcher, sleep }) =>
    createKontentAdapter({
      env: { KONTENT_ENVIRONMENT_ID: ENVIRONMENT_ID, KONTENT_SECURE_ACCESS_KEY: SECURE_KEY },
      fetcher,
      sleep,
      pageSize: 2,
      settings: { id: "kontent-ai", urls: { article: "/journal/{slug}", offer: "/offers/{slug}" } },
    }),
  transport: () => kontentTransport([...FERNHILL, ...PUBLISHED_EXTRA], { secureKey: SECURE_KEY }),
  key: SECURE_KEY,
  secrets: Object.values(KONTENT_MARKERS),
  expected: {
    types: [
      { name: "article", count: 3 },
      { name: "offer", count: 2 },
    ],
    fields: { type: "article", counts: { title: 3, summary: 1, url: 3 }, missing: "subtitle" },
    published: {
      options: { types: ["article"], fields: { article: ["title", "summary"] } },
      ids: [
        "00000000-0000-4000-8000-000000000101",
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ],
    },
    // Only the Delivery API is asked in a normal run, so there is no draft read to report.
    draftsReachable: "not-applicable",
  },
  // The first page of two items is answered; the second is the first refused.
  rateLimit: { options: {}, succeedFirst: 1, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [kontentEntry];
