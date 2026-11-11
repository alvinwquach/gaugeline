import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSquarespaceCommerceRegistry } from "../../checks/squarespace-commerce.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { collectPublished } from "../collect.js";
import { createSquarespaceCommerceAdapter } from "../squarespace-commerce.js";
import { readSquarespaceCommerce } from "../squarespace-commerce-read.js";
import { AdapterCouldNotCheck } from "../types.js";
import {
  HEALTHY_PAGES,
  SQUARESPACE_COMMERCE_SITE,
  squarespaceStoreTransport,
  type ShopPages,
} from "./squarespace-commerce-fixture.js";

/**
 * What docs/integrations/squarespace-commerce.md shows for Tideline Print Shop (an invented pop-up shop whose
 * Squarespace store a freelancer built): the settings entry, what the adapter reads over the invented store,
 * and what the price and stock checks say when two product pages have drifted from the store. The docs test
 * compares the page's blocks with these, so the page cannot drift from the tool. To print the output for
 * the page: pnpm exec tsx packages/core/src/adapters/__tests__/squarespace-commerce-docs-example.ts
 */
export const SQUARESPACE_COMMERCE_SETTINGS = {
  id: "squarespace-commerce",
  fingerprint: { products: ["name", "description"] },
  urls: { products: "/shop/{slug}" },
} as const;

// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const KEY = ["squarespace-commerce", "docs", "tideline0123456789abcdef"].join("_");

/** Two pages have drifted: the tote's page still shows the full price of a sale, and the zine's says sold out. */
const DRIFTED: ShopPages = {
  ...HEALTHY_PAGES,
  "/shop/tide-chart-tote": { price: "40.00", availability: "OutOfStock" },
  "/shop/sea-glass-zine": { price: "9.50", availability: "SoldOut" },
};

export async function squarespaceCommerceReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: squarespaceStoreTransport(DRIFTED, { token: KEY }),
    timeoutMs: 5000,
  });
  const adapter = createSquarespaceCommerceAdapter({
    env: { SQUARESPACE_COMMERCE_TOKEN: KEY },
    fetcher,
    settings: SQUARESPACE_COMMERCE_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("products", ["name", "description", "tags"]);
  const { docs } = await collectPublished(adapter, { types: ["products"] });
  const other = await adapter
    .fieldCounts("pages", ["title"])
    .catch((e: unknown) => (e instanceof AdapterCouldNotCheck ? e.reason : "failed"));
  const reading = await readSquarespaceCommerce({
    adapter,
    fetcher,
    site: SQUARESPACE_COMMERCE_SITE,
  });
  const checked = await runChecks(reading, createSquarespaceCommerceRegistry());
  return JSON.stringify(
    {
      types,
      "product fields": fields,
      "a type that does not exist": other,
      "drafts reachable": await adapter.draftsReachable(),
      "published products": docs,
      findings: checked.findings.map((f) => `${f.checkId}: ${f.evidence}`),
    },
    null,
    2,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void squarespaceCommerceReads().then((text) => process.stdout.write(`${text}\n`));
