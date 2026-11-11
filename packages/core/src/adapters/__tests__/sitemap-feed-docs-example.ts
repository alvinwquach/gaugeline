import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createSitemapFeedAdapter } from "../sitemap-feed.js";
import { AdapterCouldNotCheck } from "../types.js";
import { OAKLINE, oaklineRoutes, serve } from "./sitemap-feed-fixture.js";

/**
 * What docs/integrations/sitemap-feed.md shows for Oakline Bakery (an invented neighbourhood bakery whose
 * Squarespace site a freelancer built): the settings entry, and what the adapter reads over the invented
 * site. The docs test compares the page's blocks with these, so the page cannot drift from the tool.
 */
export const OAKLINE_SETTINGS = { id: "sitemap-feed", site: OAKLINE } as const;

export async function oaklineReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: serve(oaklineRoutes(), new URL(OAKLINE).host),
    timeoutMs: 5000,
  });
  const adapter = createSitemapFeedAdapter({
    fetcher,
    settings: OAKLINE_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fieldCounts = await adapter.fieldCounts("blog", ["title"]).then(
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
