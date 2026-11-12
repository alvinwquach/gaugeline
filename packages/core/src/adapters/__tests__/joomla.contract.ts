import { testKey } from "../../connectors/__tests__/fake.js";
import { createJoomlaAdapter } from "../joomla.js";
import type { ContractEntry } from "./contract.js";
import { JOOMLA_NOW, JOOMLA_SITE, joomlaTransport, JOOMLA_MARKERS } from "./joomla-fixture.js";

/**
 * Larkspur Yoga Studio: a small studio on Joomla 5, with its classes, notices and one draft kept as articles (see
 * joomla-fixture.ts). The API's list route is not public (Joomla's default), so every request carries the token in
 * the `X-Joomla-Token` header; the unpublished class is listed to it. The adapter reads one type: articles.
 */
const JOOMLA_KEY = testKey("joomla-adapter");

export const joomlaEntry: ContractEntry = {
  id: "joomla",
  make: ({ fetcher, sleep }) =>
    createJoomlaAdapter({
      env: { JOOMLA_URL: JOOMLA_SITE, JOOMLA_TOKEN: JOOMLA_KEY },
      fetcher,
      sleep,
      now: () => JOOMLA_NOW,
      pageSize: 2,
      settings: { id: "joomla", urls: { articles: "/studio/{slug}" } },
    }),
  transport: () => joomlaTransport(undefined, { token: JOOMLA_KEY }),
  key: JOOMLA_KEY,
  keyHeaders: { "x-joomla-token": JOOMLA_KEY },
  unknownType: "could-not-check",
  secrets: Object.values(JOOMLA_MARKERS),
  expected: {
    types: [{ name: "articles", count: 7 }],
    fields: {
      type: "articles",
      counts: { title: 7, metadesc: 2 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["articles"], fields: { articles: ["title", "metadesc"] } },
      ids: ["1", "2", "4"],
    },
    draftsReachable: true,
  },
  // The count (two requests) and the first two articles are answered; the next page is the first refused.
  rateLimit: { options: { types: ["articles"] }, succeedFirst: 3, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [joomlaEntry];
