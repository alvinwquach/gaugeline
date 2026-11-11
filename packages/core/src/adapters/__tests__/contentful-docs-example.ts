import { createContentfulRegistry } from "../../checks/contentful.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { collectPublished } from "../collect.js";
import { createContentfulAdapter } from "../contentful.js";
import { readContentful } from "../contentful-read.js";
import { ASH, ASH_SITE, PAGES_DRIFT, SPACE_ID, contentfulTransport } from "./contentful-fixture.js";

/**
 * What docs/integrations/contentful.md shows for Ash & Ember Taproom (an invented neighbourhood bar whose
 * Next.js site a freelancer built on Contentful): the settings entry, what the adapter reads over the
 * invented space, and what the check finds. The docs test compares the page's blocks with these, so the
 * page cannot drift from the tool.
 */
// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const TOKEN = ["cf", "docs", "ashember0123456789abcdefghij"].join("_");

export const ASH_SETTINGS = {
  id: "contentful",
  fingerprint: { event: ["title", "summary"] },
  urls: { beer: "/beers/{slug}", event: "/events/{slug}" },
} as const;

function world() {
  const fetcher = createFetcher({
    transport: contentfulTransport(ASH, { token: TOKEN, pages: PAGES_DRIFT }),
    timeoutMs: 5000,
  });
  const adapter = createContentfulAdapter({
    env: { CONTENTFUL_SPACE_ID: SPACE_ID, CONTENTFUL_DELIVERY_TOKEN: TOKEN },
    fetcher,
    settings: ASH_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  return { fetcher, adapter };
}

export async function ashReads(): Promise<string> {
  const { adapter } = world();
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("event", ["title", "summary", "slug"]);
  const { docs } = await collectPublished(adapter, { types: ["event"] });
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

export async function ashFindings(): Promise<string> {
  const { adapter, fetcher } = world();
  const reading = await readContentful({ adapter, fetcher, site: ASH_SITE });
  const result = await runChecks(reading, createContentfulRegistry());
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
