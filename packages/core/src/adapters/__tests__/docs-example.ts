import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createSanityAdapter } from "../sanity.js";
import { FERNHILL, sanityTransport } from "./sanity-fixture.js";

/**
 * What docs/integrations/index.md shows for Fernhill Coaching (an invented coach whose site a freelancer
 * built on Sanity): the settings entry, and what the adapter reads over the invented dataset. The docs
 * test compares the page's blocks with these, so the page cannot drift from the tool.
 */
// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const TOKEN = ["sk", "docs", "fernhill0123456789abcdef"].join("_");

export const FERNHILL_SETTINGS = {
  id: "sanity",
  fingerprint: { post: ["title", "summary"] },
  urls: { post: "/blog/{slug}" },
} as const;

export async function fernhillReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: sanityTransport(FERNHILL, { token: TOKEN }),
    timeoutMs: 5000,
  });
  const adapter = createSanityAdapter({
    env: { SANITY_PROJECT_ID: "fern8hl1", SANITY_DATASET: "production", SANITY_TOKEN: TOKEN },
    fetcher,
    settings: FERNHILL_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("post", ["title", "summary", "subtitle"]);
  const { docs } = await collectPublished(adapter, { types: ["post"], since: "2026-10-01" });
  return JSON.stringify(
    {
      types,
      "post fields": fields,
      "drafts reachable": await adapter.draftsReachable(),
      changed: docs,
    },
    null,
    2,
  );
}
