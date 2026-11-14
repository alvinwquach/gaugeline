import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { createWebflowRegistry } from "../../checks/webflow.js";
import { collectPublished } from "../collect.js";
import { createWebflowAdapter } from "../webflow.js";
import { readWebflow } from "../webflow-read.js";
import {
  PAGES_DRIFT,
  SALTMARSH,
  SALTMARSH_SITE,
  SITE_ID,
  webflowTransport,
} from "./webflow-fixture.js";

/**
 * What docs/integrations/webflow.md shows for Saltmarsh Supper Club (an invented pop-up dinner club whose
 * Webflow site a freelancer built): the settings entry, what the adapter reads over the invented site,
 * and what the two Webflow checks find. The docs test compares the page's blocks with these, so the
 * page cannot drift from the tool.
 */
// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const TOKEN = ["wf", "docs", "saltmarsh0123456789abcdef"].join("_");

export const SALTMARSH_SETTINGS = {
  id: "webflow",
  fingerprint: { events: ["name", "summary"] },
  urls: { events: "/events/{slug}", "menu-items": "/menu/{slug}" },
} as const;

function world() {
  const fetcher = createFetcher({
    transport: webflowTransport(SALTMARSH, { token: TOKEN, pages: PAGES_DRIFT }),
    timeoutMs: 5000,
  });
  const adapter = createWebflowAdapter({
    env: { WEBFLOW_TOKEN: TOKEN, WEBFLOW_SITE_ID: SITE_ID },
    fetcher,
    settings: SALTMARSH_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  return { fetcher, adapter };
}

export async function saltmarshReads(): Promise<string> {
  const { adapter } = world();
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("events", ["name", "summary", "seats"]);
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

export async function saltmarshFindings(): Promise<string> {
  const { adapter, fetcher } = world();
  const reading = await readWebflow({ adapter, fetcher, site: SALTMARSH_SITE });
  const result = await runChecks(reading, createWebflowRegistry());
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
