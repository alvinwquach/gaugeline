import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { createStrapiRegistry } from "../../checks/strapi.js";
import { collectPublished } from "../collect.js";
import { createStrapiAdapter } from "../strapi.js";
import { readStrapi } from "../strapi-read.js";
import { BRASS, BRASS_SITE, CMS_URL, PAGES_DRIFT, strapiTransport } from "./strapi-fixture.js";

/**
 * What docs/integrations/strapi.md shows for Brass Anchor Taproom (an invented neighbourhood bar whose
 * Next.js site a freelancer built on a Strapi backend): the settings entry, what the adapter reads
 * over the invented site, and what the two Strapi checks find. The docs test compares the page's
 * blocks with these, so the page cannot drift from the tool.
 */
// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const TOKEN = ["strapi", "docs", "brassanchor0123456789abcdef"].join("_");

export const BRASS_SETTINGS = {
  id: "strapi",
  fingerprint: { events: ["title", "blurb"] },
  urls: { events: "/events/{slug}", "menu-items": "/menu/{slug}" },
} as const;

function world() {
  const fetcher = createFetcher({
    transport: strapiTransport(BRASS, {
      token: TOKEN,
      pages: PAGES_DRIFT,
      // The Public role was left open on events by mistake: the leak the second check looks for.
      publicPublished: ["events", "menu-items"],
      publicDrafts: ["events"],
    }),
    timeoutMs: 5000,
  });
  const adapter = createStrapiAdapter({
    env: { STRAPI_URL: CMS_URL, STRAPI_TOKEN: TOKEN },
    fetcher,
    settings: BRASS_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  return { fetcher, adapter };
}

export async function brassReads(): Promise<string> {
  const { adapter } = world();
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("events", ["title", "blurb", "slug", "seats"]);
  const { docs } = await collectPublished(adapter, { types: ["events"] });
  return JSON.stringify(
    {
      types,
      "event fields": fields,
      "drafts reachable": await adapter.draftsReachable(),
      "published events": docs,
    },
    null,
    2,
  );
}

export async function brassFindings(): Promise<string> {
  const { adapter, fetcher } = world();
  const reading = await readStrapi({ adapter, fetcher, site: BRASS_SITE, ownerConsent: true });
  const result = await runChecks(reading, createStrapiRegistry());
  return JSON.stringify(
    {
      findings: result.findings.map((f) => ({
        check: f.checkId,
        severity: f.severity,
        evidence: f.evidence,
        url: f.url,
      })),
      "could not check": result.couldNotCheck,
      passed: result.passed,
    },
    null,
    2,
  );
}
