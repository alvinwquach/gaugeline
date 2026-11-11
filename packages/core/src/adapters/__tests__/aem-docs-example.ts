import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createAemAdapter } from "../aem.js";
import { AdapterCouldNotCheck } from "../types.js";
import { aemTransport } from "./aem-fixture.js";

/**
 * What docs/integrations/aem.md shows for Larkspur Yoga Studio (an invented small studio whose Adobe Experience Manager site
 * a freelancer built): the settings entry, and what the adapter reads over the invented site. The docs test
 * compares the page's blocks with these, so the page cannot drift from the tool. To print the output for
 * the page: pnpm exec tsx packages/core/src/adapters/__tests__/aem-docs-example.ts
 */
export const AEM_SETTINGS = {
  id: "aem",
  fingerprint: { classes: ["name", "summary"] },
  urls: { classes: "/classes/{slug}", teachers: "/teachers/{slug}" },
} as const;

export async function aemReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: aemTransport(),
    timeoutMs: 5000,
  });
  const adapter = createAemAdapter({
    env: {},
    fetcher,
    settings: AEM_SETTINGS,
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
  void aemReads().then((text) => process.stdout.write(`${text}\n`));
