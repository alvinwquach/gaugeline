import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createWordPressAdapter } from "../wordpress.js";
import { WP_ENV, WP_USER } from "./entries.js";
import { wordpressTransport } from "./wordpress-fixture.js";

/**
 * What docs/integrations/wordpress.md shows for the Copper Lantern (an invented cocktail bar whose site a
 * freelancer built on WordPress with Elementor): the settings entry, and what the adapter reads over the
 * invented site for posts changed since 1 October. The docs test compares the page's blocks with these, so the
 * page cannot drift from the tool.
 */
export const COPPER_LANTERN_SETTINGS = {
  id: "wordpress",
  fingerprint: { post: ["title", "excerpt"] },
} as const;

export async function copperLanternReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: wordpressTransport(undefined, {
      app: { user: WP_USER, password: WP_ENV.WORDPRESS_APP_PASSWORD },
    }),
    timeoutMs: 5000,
  });
  const adapter = createWordPressAdapter({
    env: WP_ENV,
    fetcher,
    settings: COPPER_LANTERN_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("post", ["title", "excerpt", "subtitle"]);
  const { docs } = await collectPublished(adapter, { types: ["post"], since: "2026-10-01" });
  return JSON.stringify(
    {
      types,
      "post fields": fields,
      "drafts reachable": await adapter.draftsReachable(),
      changed: docs,
    },
    null,
    2,
  );
}
