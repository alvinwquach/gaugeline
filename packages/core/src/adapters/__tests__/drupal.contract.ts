import { testKey } from "../../connectors/__tests__/fake.js";
import { createDrupalAdapter } from "../drupal.js";
import type { ContractEntry } from "./contract.js";
import { DRUPAL_MARKERS, DRUPAL_SITE, drupalTransport } from "./drupal-fixture.js";

/**
 * Fernlea Family Clinic: a clinic whose Drupal holds news articles and pages (some never published; see
 * drupal-fixture.ts). Published content needs no key, so the published reads carry none; the credential (a bearer
 * token of a user whose role can view unpublished content) is sent for the unpublished read only, and the settings
 * allow it. Drupal's JSON:API lists no types to the adapter, so the settings name them.
 */
const DRUPAL_KEY = testKey("drupal-adapter");

export const drupalEntry: ContractEntry = {
  id: "drupal",
  make: ({ fetcher, sleep }) =>
    createDrupalAdapter({
      env: { DRUPAL_URL: DRUPAL_SITE, DRUPAL_TOKEN: DRUPAL_KEY },
      fetcher,
      sleep,
      settings: {
        id: "drupal",
        urls: { "node--article": "/news/{id}", "node--page": "/pages/{id}" },
        readUnpublished: true,
      },
    }),
  transport: () =>
    drupalTransport(undefined, { credential: { kind: "bearer", token: DRUPAL_KEY } }),
  key: DRUPAL_KEY,
  keyHeader: { value: `Bearer ${DRUPAL_KEY}` },
  secrets: Object.values(DRUPAL_MARKERS),
  expected: {
    types: [
      { name: "node--article", count: 2 },
      { name: "node--page", count: 1 },
    ],
    fields: {
      type: "node--article",
      counts: { title: 2, field_subtitle: 1 },
      missing: "field_teaser",
    },
    published: {
      options: {
        types: ["node--article"],
        fields: { "node--article": ["title", "field_subtitle"] },
      },
      ids: ["5f1c0a10-0000-4000-8000-000000000001", "5f1c0a10-0000-4000-8000-000000000002"],
    },
    draftsReachable: true,
  },
  // The first type's page is answered; the second's is the first refused.
  rateLimit: { options: { types: ["node--article", "node--page"] }, succeedFirst: 1, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [drupalEntry];
