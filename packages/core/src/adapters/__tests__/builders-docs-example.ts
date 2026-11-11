import { createFetcher } from "../../fetcher.js";
import { builderById, createBuilderAdapter, suggestBuilder } from "../builders.js";
import { collectPublished } from "../collect.js";
import { AdapterCouldNotCheck } from "../types.js";
import { TIDEWATER, TIDEWATER_HOME, tidewaterRoutes, tidewaterServe } from "./builders-fixture.js";

/**
 * What docs/integrations/builders.md shows for Tidewater Pop-Up (an invented sea-glass jewellery pop-up
 * whose Squarespace site a freelancer built): the settings entry, the hint, and what the adapter reads
 * over the invented site. The docs test compares the page's blocks with these, so the page cannot drift
 * from the tool.
 */
export const TIDEWATER_SETTINGS = { id: "squarespace", site: TIDEWATER } as const;

export function tidewaterHint(): string {
  return JSON.stringify(suggestBuilder(TIDEWATER_HOME, `${TIDEWATER}/`), null, 2);
}

export async function tidewaterReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: tidewaterServe(tidewaterRoutes()),
    timeoutMs: 5000,
  });
  const platform = builderById("squarespace");
  if (platform === undefined) throw new Error("squarespace is not a builder");
  const adapter = createBuilderAdapter(platform, {
    fetcher,
    settings: TIDEWATER_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fieldCounts = await adapter.fieldCounts("shop", ["title"]).then(
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
