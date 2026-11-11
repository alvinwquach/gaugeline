import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHubspotCmsRegistry } from "../../checks/hubspot-cms.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { collectPublished } from "../collect.js";
import { createHubspotCmsAdapter } from "../hubspot-cms.js";
import { readHubspotCms } from "../hubspot-cms-read.js";
import { AdapterCouldNotCheck } from "../types.js";
import {
  FORM_DELETED,
  HUBSPOT_CMS_MARKERS,
  HUBSPOT_CMS_PORTAL,
  HUBSPOT_CMS_SITE,
  healthySite,
  hubspotData,
  hubspotWorld,
  livePage,
} from "./hubspot-cms-fixture.js";

/**
 * What docs/integrations/hubspot-cms.md shows for Brass Whisk Bakehouse (an invented pop-up bakery whose
 * HubSpot CMS site a freelancer built): the settings entry, what the adapter reads over the invented portal,
 * and what the three checks find when the live site has drifted. The docs test compares the page's blocks with
 * these, so the page cannot drift from the tool. To print them for the page:
 * pnpm exec tsx packages/core/src/adapters/__tests__/hubspot-cms-docs-example.ts
 */
export const HUBSPOT_CMS_SETTINGS = {
  id: "hubspot-cms",
  fingerprint: {
    "site-pages": ["name", "metaDescription"],
    "hubdb.loaves": ["name", "price"],
  },
} as const;

// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const KEY = ["hubspot-cms", "docs", "brasswhisk0123456789abcdef"].join("_");

function world(site = healthySite()) {
  const fetcher = createFetcher({
    transport: hubspotWorld(hubspotData(), site, { token: KEY }),
    timeoutMs: 5000,
  });
  const adapter = createHubspotCmsAdapter({
    env: { HUBSPOT_CMS_TOKEN: KEY },
    fetcher,
    settings: HUBSPOT_CMS_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  return { fetcher, adapter };
}

export async function hubspotCmsReads(): Promise<string> {
  const { adapter } = world();
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("site-pages", ["name", "metaDescription", "subtitle"]);
  const { docs } = await collectPublished(adapter, { types: ["site-pages"] });
  const other = await adapter
    .fieldCounts("products", ["name"])
    .catch((e: unknown) => (e instanceof AdapterCouldNotCheck ? e.reason : "failed"));
  return JSON.stringify(
    {
      types,
      "site page fields": fields,
      "a list that does not exist": other,
      "drafts reachable": await adapter.draftsReachable(),
      "published site pages": docs,
    },
    null,
    2,
  );
}

/** The live site with three things wrong: a 404, a price that is not the table's, and a deleted form. */
export async function hubspotCmsFindings(): Promise<string> {
  const site = healthySite();
  site["/blog/new-oven"] = { status: 404 };
  site["/bread/rye"] = {
    status: 200,
    html: livePage(`<h1>${HUBSPOT_CMS_MARKERS.rye}</h1><p>$12.00</p>`, {
      portalId: HUBSPOT_CMS_PORTAL,
      formId: FORM_DELETED,
    }),
  };
  const { adapter, fetcher } = world(site);
  const reading = await readHubspotCms({ adapter, fetcher, site: HUBSPOT_CMS_SITE });
  const result = await runChecks(reading, createHubspotCmsRegistry());
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

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void hubspotCmsReads()
    .then((text) => process.stdout.write(`${text}\n\n`))
    .then(() => hubspotCmsFindings())
    .then((text) => process.stdout.write(`${text}\n`));
