import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createAemAdapter } from "../aem.js";
import { AdapterCouldNotCheck } from "../types.js";
import { AEM_ENV, aemTransport } from "./aem-fixture.js";

/**
 * What docs/integrations/aem.md shows for Harbourline Hotels (an invented hotel group whose Adobe Experience Manager
 * site a freelancer's agency built): the settings entry, and what the adapter reads over the invented publish tier.
 * The docs test compares the page's blocks with these, so the page cannot drift from the tool. To print the output
 * for the page: pnpm exec tsx packages/core/src/adapters/__tests__/aem-docs-example.ts
 */
export const AEM_SETTINGS = {
  id: "aem",
  fingerprint: { rooms: ["name", "summary"] },
  urls: { rooms: "/rooms/{slug}", offers: "/offers/{slug}", venues: "/venues/{slug}" },
} as const;

export async function aemReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: aemTransport(),
    timeoutMs: 5000,
  });
  const adapter = createAemAdapter({
    env: AEM_ENV,
    fetcher,
    settings: AEM_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("rooms", ["name", "summary", "sleeps", "subtitle"]);
  const { docs } = await collectPublished(adapter, { types: ["rooms"] });
  const other = await adapter
    .fieldCounts("spa", ["name"])
    .catch((e: unknown) => (e instanceof AdapterCouldNotCheck ? e.reason : "failed"));
  return JSON.stringify(
    {
      types,
      "room fields": fields,
      "a query that is not named": other,
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
  void aemReads().then((text) => process.stdout.write(`${text}\n`));
