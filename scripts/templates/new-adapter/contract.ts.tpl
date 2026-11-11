#if key
import { testKey } from "../../connectors/__tests__/fake.js";
#end
import { create$PASCAL$Adapter } from "../$ID$.js";
import type { ContractEntry } from "./contract.js";
#if live
import { $CAMEL$Routes, $CAMEL$Serve, $P$_MARKERS, $P$_SITE } from "./$ID$-fixture.js";
#else
import { $CAMEL$Transport, $P$_MARKERS } from "./$ID$-fixture.js";
#end

/**
#if live
 * Larkspur Yoga Studio: a small studio on $NAME$. The live site's sitemap is all Gaugeline reads, so there
 * are no fields, no key and no drafts (see $ID$-fixture.ts). TODO(new:adapter) say why in one sentence.
#else
 * Larkspur Yoga Studio: a small studio on $NAME$, with classes (one a draft), notices and teachers (see
 * $ID$-fixture.ts). TODO(new:adapter) describe the invented site in terms of the platform.
#end
 */
#if key
const $P$_KEY = testKey("$ID$-adapter");

#end
export const $CAMEL$Entry: ContractEntry = {
  id: "$ID$",
#if live
  make: ({ fetcher, sleep }) => create$PASCAL$Adapter({ fetcher, site: $P$_SITE, sleep }),
  transport: () => $CAMEL$Serve($CAMEL$Routes()),
  secrets: Object.values($P$_MARKERS),
  expected: {
    types: [
      { name: "classes", count: 2 },
      { name: "teachers", count: 2 },
      { name: "top-level", count: 3 },
    ],
    published: {
      options: { types: ["classes", "teachers"] },
      ids: [
        `${$P$_SITE}/classes/morning-flow`,
        `${$P$_SITE}/classes/evening-stretch`,
        `${$P$_SITE}/teachers/ana`,
        `${$P$_SITE}/teachers/ben`,
      ],
    },
    draftsReachable: "not-applicable",
  },
  // robots.txt and the sitemap are answered; the home page (looked at for feed links) is the first refused.
  rateLimit: { options: { types: ["classes", "teachers"] }, succeedFirst: 2, atLeast: 4 },
};
#else
  make: ({ fetcher, sleep }) =>
    create$PASCAL$Adapter({
#if key
      env: { $P$_TOKEN: $P$_KEY },
#else
      env: {},
#end
      fetcher,
      sleep,
    }),
#if key
  transport: () => $CAMEL$Transport(undefined, { token: $P$_KEY }),
  key: $P$_KEY,
#else
  transport: () => $CAMEL$Transport(),
#end
  secrets: Object.values($P$_MARKERS),
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
#if key
    draftsReachable: true,
#else
    draftsReachable: "not-applicable",
#end
  },
  // The types and the first type's page are answered; the second type's page is the first refused.
  rateLimit: { options: { types: ["classes", "teachers"] }, succeedFirst: 2, atLeast: 2 },
};
#end

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [$CAMEL$Entry];
