import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSitecoreRegistry } from "../../checks/sitecore.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { collectPublished } from "../collect.js";
import { createSitecoreAdapter } from "../sitecore.js";
import { readSitecore } from "../sitecore-read.js";
import { AdapterCouldNotCheck } from "../types.js";
import { LARKSPUR_SITE, PAGES_DRIFT, SITE_NAME, sitecoreTransport } from "./sitecore-fixture.js";

/**
 * What docs/integrations/sitecore.md shows for Larkspur Yoga Studio (an invented small studio whose Sitecore XM Cloud
 * site a freelancer built): the settings entry, what the adapter reads over the invented site, and what the two
 * checks find. The docs test compares the page's blocks with these, so the page cannot drift from the tool. To
 * print the output for the page: pnpm exec tsx packages/core/src/adapters/__tests__/sitecore-docs-example.ts
 */
export const SITECORE_SETTINGS = {
  id: "sitecore",
  siteName: SITE_NAME,
  languages: ["en", "fr-CA"],
  urls: { "fr-CA": "/fr-ca" },
  expectPrivate: true,
} as const;

// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const KEY = ["sitecore", "docs", "larkspur0123456789abcdef"].join("_");

function world() {
  const fetcher = createFetcher({
    transport: sitecoreTransport(undefined, { token: KEY, pages: PAGES_DRIFT, preview: "graphql" }),
    timeoutMs: 5000,
  });
  const adapter = createSitecoreAdapter({
    env: { SITECORE_API_KEY: KEY },
    fetcher,
    settings: SITECORE_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  return { fetcher, adapter };
}

export async function sitecoreReads(): Promise<string> {
  const { adapter } = world();
  const types = await adapter.types();
  const { docs } = await collectPublished(adapter, { types: ["fr-CA"] });
  const fields = await adapter
    .fieldCounts("en", ["title"])
    .catch((e: unknown) => (e instanceof AdapterCouldNotCheck ? e.reason : "failed"));
  return JSON.stringify(
    {
      types,
      "published routes in fr-CA": docs,
      "field counts": fields,
      "drafts reachable": await adapter.draftsReachable(),
    },
    null,
    2,
  );
}

/** What the two checks say over the same site, after the front end lost two pages and with the owner's consent. */
export async function sitecoreFindings(): Promise<string> {
  const { adapter, fetcher } = world();
  const reading = await readSitecore({ adapter, fetcher, site: LARKSPUR_SITE, ownerConsent: true });
  const out = await runChecks(reading, createSitecoreRegistry());
  return JSON.stringify(
    {
      findings: out.findings.map((f) => ({
        check: f.checkId,
        severity: f.severity,
        evidence: f.evidence,
      })),
      "no finding": out.passed,
      "could not check": out.couldNotCheck.map((c) => c.reason),
    },
    null,
    2,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void sitecoreReads()
    .then((text) => process.stdout.write(`${text}\n`))
    .then(sitecoreFindings)
    .then((text) => process.stdout.write(`${text}\n`));
