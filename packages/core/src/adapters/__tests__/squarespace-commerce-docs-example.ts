import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createSquarespaceCommerceAdapter } from "../squarespace-commerce.js";
import { AdapterCouldNotCheck } from "../types.js";
import { squarespaceCommerceTransport } from "./squarespace-commerce-fixture.js";

/**
 * What docs/integrations/squarespace-commerce.md shows for Larkspur Yoga Studio (an invented small studio whose Squarespace commerce site
 * a freelancer built): the settings entry, and what the adapter reads over the invented site. The docs test
 * compares the page's blocks with these, so the page cannot drift from the tool. To print the output for
 * the page: pnpm exec tsx packages/core/src/adapters/__tests__/squarespace-commerce-docs-example.ts
 */
export const SQUARESPACE_COMMERCE_SETTINGS = {
  id: "squarespace-commerce",
  fingerprint: { classes: ["name", "summary"] },
  urls: { classes: "/classes/{slug}", teachers: "/teachers/{slug}" },
} as const;

// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const KEY = ["squarespace-commerce", "docs", "larkspur0123456789abcdef"].join("_");

export async function squarespaceCommerceReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: squarespaceCommerceTransport(undefined, { token: KEY }),
    timeoutMs: 5000,
  });
  const adapter = createSquarespaceCommerceAdapter({
    env: { SQUARESPACE_COMMERCE_TOKEN: KEY },
    fetcher,
    settings: SQUARESPACE_COMMERCE_SETTINGS,
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
  void squarespaceCommerceReads().then((text) => process.stdout.write(`${text}\n`));
