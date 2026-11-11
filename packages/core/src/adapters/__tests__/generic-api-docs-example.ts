import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createGenericApiAdapter } from "../generic-api.js";
import { HERON_API, heronTransport } from "./generic-api-fixture.js";

/**
 * What docs/integrations/generic-api.md shows for Heron Yoga Studio (an invented studio; its freelancer wired a
 * Payload-style list, a Directus-style list and a GraphQL connection into one mapping): the settings entry, and what the
 * adapter reads. The docs test compares the page's blocks with these, so the page cannot drift from the tool.
 */
const KEY = ["heron", "docs", "0123456789abcdef"].join("_");

export const HERON_SETTINGS = {
  id: "generic-api",
  fingerprint: { post: ["title", "summary"] },
  urls: { post: "/blog/{slug}", class: "/classes/{slug}" },
  api: HERON_API,
} as const;

export async function heronReads(): Promise<string> {
  const fetcher = createFetcher({ transport: heronTransport({ key: KEY }), timeoutMs: 5000 });
  const adapter = createGenericApiAdapter({
    env: { GAUGELINE_HERON_TOKEN: KEY },
    fetcher,
    settings: HERON_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const { docs } = await collectPublished(adapter, { types: ["post"], limit: 2 });
  return JSON.stringify(
    {
      types: await adapter.types(),
      "drafts reachable": await adapter.draftsReachable(),
      "changed posts": docs,
    },
    null,
    2,
  );
}
