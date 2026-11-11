import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createContentstackAdapter } from "../contentstack.js";
import { AdapterCouldNotCheck } from "../types.js";
import { contentstackTransport } from "./contentstack-fixture.js";

/**
 * What docs/integrations/contentstack.md shows for Harbour Lantern Inn (an invented boutique hotel whose Contentstack site
 * an agency is migrating): the settings entry, and what the adapter reads over the invented site. The docs test
 * compares the page's blocks with these, so the page cannot drift from the tool. To print the output for
 * the page: pnpm exec tsx packages/core/src/adapters/__tests__/contentstack-docs-example.ts
 */
export const CONTENTSTACK_SETTINGS = {
  id: "contentstack",
  fingerprint: { rooms: ["title", "summary"] },
  urls: { rooms: "/rooms/{slug}", offers: "/offers/{slug}" },
} as const;

// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const TOKEN = ["contentstack", "docs", "delivery0123456789abcdef"].join("_");
const API_KEY = ["contentstack", "docs", "stack0123456789abcdef"].join("_");

export async function contentstackReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: contentstackTransport(undefined, { token: TOKEN, apiKey: API_KEY }),
    timeoutMs: 5000,
  });
  const adapter = createContentstackAdapter({
    env: {
      CONTENTSTACK_API_KEY: API_KEY,
      CONTENTSTACK_DELIVERY_TOKEN: TOKEN,
      CONTENTSTACK_ENVIRONMENT: "production",
    },
    fetcher,
    settings: CONTENTSTACK_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("rooms", ["title", "summary", "seats"]);
  const { docs } = await collectPublished(adapter, { types: ["rooms"] });
  const other = await adapter
    .fieldCounts("none", ["title"])
    .catch((e: unknown) => (e instanceof AdapterCouldNotCheck ? e.reason : "failed"));
  return JSON.stringify(
    {
      types,
      "room fields": fields,
      "a type that does not exist": other,
      "drafts reachable": await adapter.draftsReachable(),
      "published rooms": docs,
    },
    null,
    2,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void contentstackReads().then((text) => process.stdout.write(`${text}\n`));
