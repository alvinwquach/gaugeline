import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { createDirectusRegistry } from "../../checks/directus.js";
import { collectPublished } from "../collect.js";
import { createDirectusAdapter } from "../directus.js";
import { readDirectus } from "../directus-read.js";
import {
  CMS_URL,
  DIRECTUS_SITE,
  LARKSPUR,
  PAGES_DRIFT,
  directusTransport,
} from "./directus-fixture.js";

/**
 * What docs/integrations/directus.md shows for Larkspur Yoga Studio (an invented small studio whose Next.js site a
 * freelancer built on a Directus backend): the settings entry, what the adapter reads over the invented site, and
 * what the two Directus checks find. The docs test compares the page's blocks with these, so the page cannot
 * drift from the tool. To print both for the page:
 * pnpm exec tsx packages/core/src/adapters/__tests__/directus-docs-example.ts
 */
export const DIRECTUS_SETTINGS = {
  id: "directus",
  fingerprint: { classes: ["name", "summary"] },
  urls: { classes: "/classes/{slug}", teachers: "/teachers/{slug}" },
  privateCollections: ["appointments"],
} as const;

// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const TOKEN = ["directus", "docs", "larkspur0123456789abcdef"].join("_");

function world() {
  const fetcher = createFetcher({
    transport: directusTransport(LARKSPUR, {
      token: TOKEN,
      pages: PAGES_DRIFT,
      // The Public role was left open on appointments by mistake: the leak the second check looks for.
      publicRead: ["appointments"],
    }),
    timeoutMs: 5000,
  });
  const adapter = createDirectusAdapter({
    env: { DIRECTUS_URL: CMS_URL, DIRECTUS_TOKEN: TOKEN },
    fetcher,
    settings: DIRECTUS_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  return { fetcher, adapter };
}

export async function directusReads(): Promise<string> {
  const { adapter } = world();
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("classes", ["name", "summary", "slug", "seats"]);
  const { docs } = await collectPublished(adapter, { types: ["classes"] });
  return JSON.stringify(
    {
      types,
      "class fields": fields,
      "drafts reachable": await adapter.draftsReachable(),
      "published classes": docs,
    },
    null,
    2,
  );
}

export async function directusFindings(): Promise<string> {
  const { adapter, fetcher } = world();
  const reading = await readDirectus({ adapter, fetcher, site: DIRECTUS_SITE, ownerConsent: true });
  const result = await runChecks(reading, createDirectusRegistry());
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
  void directusReads().then(async (text) => {
    process.stdout.write(`${text}\n\n${await directusFindings()}\n`);
  });
