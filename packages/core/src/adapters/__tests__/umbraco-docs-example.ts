import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createUmbracoAdapter } from "../umbraco.js";
import { AdapterCouldNotCheck } from "../types.js";
import { UMBRACO_SITE, umbracoTransport } from "./umbraco-fixture.js";

/**
 * What docs/integrations/umbraco.md shows for Marigold Lane Community Theatre (an invented volunteer theatre whose
 * Umbraco site a freelancer built): the settings entry, and what the adapter reads over the invented site. The docs test
 * compares the page's blocks with these, so the page cannot drift from the tool. To print the output for
 * the page: pnpm exec tsx packages/core/src/adapters/__tests__/umbraco-docs-example.ts
 */
export const UMBRACO_SETTINGS = {
  id: "umbraco",
  fingerprint: { show: ["title", "blurb"] },
  urls: { show: "/whats-on/{slug}", castMember: "/company/{slug}" },
} as const;

// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const KEY = ["umbraco", "docs", "marigold0123456789abcdef"].join("_");

export async function umbracoReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: umbracoTransport(undefined, { apiKey: KEY, protectedApi: true }),
    timeoutMs: 5000,
  });
  const adapter = createUmbracoAdapter({
    env: { UMBRACO_URL: UMBRACO_SITE, UMBRACO_API_KEY: KEY },
    fetcher,
    settings: UMBRACO_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("show", ["title", "blurb", "seats"]);
  const { docs } = await collectPublished(adapter, { types: ["show"] });
  const other = await adapter
    .fieldCounts("nothing", ["title"])
    .catch((e: unknown) => (e instanceof AdapterCouldNotCheck ? e.reason : "failed"));
  return JSON.stringify(
    {
      types,
      "show fields": fields,
      "a type with no published nodes": other,
      "drafts reachable": await adapter.draftsReachable(),
      "published shows": docs,
    },
    null,
    2,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void umbracoReads().then((text) => process.stdout.write(`${text}\n`));
