import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createWixAdapter } from "../wix.js";
import { AdapterCouldNotCheck } from "../types.js";
import { MARLOW, marlowRoutes, marlowServe } from "./wix-fixture.js";

/**
 * What docs/integrations/wix.md shows for Marlow Coaching (an invented career-coaching practice whose Wix site a
 * freelancer built): the settings entry, and what the adapter reads over the invented site. The docs test
 * compares the page's blocks with these, so the page cannot drift from the tool.
 */
export const MARLOW_SETTINGS = { id: "wix", site: MARLOW } as const;

export async function marlowReads(): Promise<string> {
  const fetcher = createFetcher({ transport: marlowServe(marlowRoutes()), timeoutMs: 5000 });
  const adapter = createWixAdapter({
    fetcher,
    settings: MARLOW_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fieldCounts = await adapter.fieldCounts("programs", ["title"]).then(
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
