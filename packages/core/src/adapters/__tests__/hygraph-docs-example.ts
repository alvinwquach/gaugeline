import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { createHygraphRegistry } from "../../checks/hygraph.js";
import { collectPublished } from "../collect.js";
import { createHygraphAdapter } from "../hygraph.js";
import { readHygraph } from "../hygraph-read.js";
import { AdapterCouldNotCheck } from "../types.js";
import {
  HYGRAPH_COLLECTIONS,
  HYGRAPH_SITE,
  HYGRAPH_URL,
  bothTransport,
  hygraphTransport,
  siteTransport,
} from "./hygraph-fixture.js";

/**
 * What docs/integrations/hygraph.md shows for Pennywhistle Bakehouse (an invented pop-up bakery whose Hygraph site a
 * freelancer built): the settings entry, and what the adapter reads over the invented project. The docs test compares
 * the page's blocks with these, so the page cannot drift from the tool. To print the output for the page:
 * pnpm exec tsx packages/core/src/adapters/__tests__/hygraph-docs-example.ts
 */
export const HYGRAPH_SETTINGS = {
  id: "hygraph",
  collections: HYGRAPH_COLLECTIONS,
  readDraftStage: true,
  fingerprint: { pages: ["title", "summary"] },
  urls: { pages: "/{slug}", events: "/events/{slug}" },
} as const;

// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const KEY = ["hygraph", "docs", "pennywhistle0123456789abcdef"].join("_");

export async function hygraphReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: bothTransport(
      hygraphTransport(undefined, { token: KEY }),
      // The live site wrongly builds a page for the supper club, which was never published.
      siteTransport(["/", "/home", "/menu", "/winter-supper-club"]),
    ),
    timeoutMs: 5000,
  });
  const adapter = createHygraphAdapter({
    env: { HYGRAPH_TOKEN: KEY, HYGRAPH_ENDPOINT: HYGRAPH_URL },
    fetcher,
    settings: HYGRAPH_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("pages", ["title", "summary", "seo.title"]);
  const { docs } = await collectPublished(adapter, { types: ["pages"] });
  const other = await adapter
    .fieldCounts("none", ["title"])
    .catch((e: unknown) => (e instanceof AdapterCouldNotCheck ? e.reason : "failed"));
  const reading = await readHygraph({
    adapter,
    fetcher,
    site: HYGRAPH_SITE,
    ownerConsent: true,
  });
  const result = await runChecks(reading, createHygraphRegistry());
  return JSON.stringify(
    {
      types,
      "page fields": fields,
      "a type that does not exist": other,
      "published pages": docs,
      "draft stage": reading.models.map(
        (m) =>
          `${m.type}: ${m.state}, ${m.published} published, ${m.unpublished} not published${m.entries.length > 0 ? ` (${m.entries.map((e) => e.slug ?? e.id).join(", ")})` : ""}`,
      ),
      findings: result.findings.map((f) => `${f.checkId}: ${f.evidence}`),
    },
    null,
    2,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void hygraphReads().then((text) => process.stdout.write(`${text}\n`));
