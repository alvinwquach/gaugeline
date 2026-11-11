import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createFramerAdapter } from "../framer.js";
import { AdapterCouldNotCheck } from "../types.js";
import { LANTERN, lanternRoutes, lanternServe } from "./framer-fixture.js";

/**
 * What docs/integrations/framer.md shows for Lantern Row (an invented ceramics pop-up whose Framer site a
 * freelancer built): the settings entry, and what the adapter reads over the invented site. The docs test
 * compares the page's blocks with these, so the page cannot drift from the tool.
 */
export const LANTERN_SETTINGS = { id: "framer", site: LANTERN } as const;

export async function lanternReads(): Promise<string> {
  const fetcher = createFetcher({ transport: lanternServe(lanternRoutes()), timeoutMs: 5000 });
  const adapter = createFramerAdapter({
    fetcher,
    settings: LANTERN_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fieldCounts = await adapter.fieldCounts("journal", ["title"]).then(
    () => "answered",
    (e: unknown) => (e instanceof AdapterCouldNotCheck ? `could not check: ${e.reason}` : "failed"),
  );
  const { docs } = await collectPublished(adapter, { since: "2026-11-01" });
  return JSON.stringify(
    {
      types,
      "field counts": fieldCounts,
      "drafts reachable": await adapter.draftsReachable(),
      "changed since 1 November": docs,
    },
    null,
    2,
  );
}
