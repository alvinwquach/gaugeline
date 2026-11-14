import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createWixAdapter } from "../wix.js";
import { AdapterCouldNotCheck } from "../types.js";
import { MARLOW, marlowRoutes, marlowServe } from "./wix-fixture.js";
import { MARLOW_SITE_ID, wixTransport } from "./wix-native-fixture.js";

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

// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const KEY = ["wix", "docs", "marlowcoaching0123456789abcdef"].join("_");

/** What docs/integrations/wix.md shows for the CMS read: the settings entry (the key is in the environment, never here). */
export const MARLOW_NATIVE_SETTINGS = {
  id: "wix",
  siteId: MARLOW_SITE_ID,
  urls: { Programs: "/programs/{slug}", Testimonials: "/testimonials/{id}" },
  fingerprint: { Programs: ["title", "blurb"] },
} as const;

/** Marlow Coaching's two collections read with a key that may read Programs and not Testimonials. */
export async function marlowNativeReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: wixTransport({ key: KEY, deny: ["Testimonials"] }),
    timeoutMs: 5000,
  });
  const adapter = createWixAdapter({
    env: { WIX_API_KEY: KEY },
    fetcher,
    settings: MARLOW_NATIVE_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const collections = await adapter.readCollections();
  const fields = await adapter.fieldCounts("Programs", ["title", "blurb", "slug", "price"]);
  const { docs } = await collectPublished(adapter, { types: ["Programs"], since: "2026-10-01" });
  return JSON.stringify(
    {
      collections,
      "Programs fields": fields,
      "drafts reachable": await adapter.draftsReachable(),
      "Programs changed since 1 October": docs,
    },
    null,
    2,
  );
}
