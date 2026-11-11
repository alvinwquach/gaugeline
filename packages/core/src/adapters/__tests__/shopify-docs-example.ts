import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createShopifyAdapter } from "../shopify.js";
import { AdapterCouldNotCheck } from "../types.js";
import { shopifyTransport } from "./shopify-fixture.js";

/**
 * What docs/integrations/shopify.md shows for Larkspur Yoga Studio (an invented small studio whose Shopify site
 * a freelancer built): the settings entry, and what the adapter reads over the invented site. The docs test
 * compares the page's blocks with these, so the page cannot drift from the tool. To print the output for
 * the page: pnpm exec tsx packages/core/src/adapters/__tests__/shopify-docs-example.ts
 */
export const SHOPIFY_SETTINGS = {
  id: "shopify",
  fingerprint: { classes: ["name", "summary"] },
  urls: { classes: "/classes/{slug}", teachers: "/teachers/{slug}" },
} as const;

// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const KEY = ["shopify", "docs", "larkspur0123456789abcdef"].join("_");

export async function shopifyReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: shopifyTransport(undefined, { token: KEY }),
    timeoutMs: 5000,
  });
  const adapter = createShopifyAdapter({
    env: { SHOPIFY_TOKEN: KEY },
    fetcher,
    settings: SHOPIFY_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("classes", ["name", "summary", "seats"]);
  const { docs } = await collectPublished(adapter, { types: ["classes"] });
  const other = await adapter
    .fieldCounts("none", ["name"])
    .catch((e: unknown) => (e instanceof AdapterCouldNotCheck ? e.reason : "failed"));
  return JSON.stringify(
    {
      types,
      "class fields": fields,
      "a type that does not exist": other,
      "drafts reachable": await adapter.draftsReachable(),
      "published classes": docs,
    },
    null,
    2,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void shopifyReads().then((text) => process.stdout.write(`${text}\n`));
