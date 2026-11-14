import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { createDrupalRegistry } from "../../checks/drupal.js";
import { collectPublished } from "../collect.js";
import { createDrupalAdapter } from "../drupal.js";
import { readDrupal } from "../drupal-read.js";
import { DRUPAL_SITE, FERNLEA, PAGES_LEAK, drupalTransport } from "./drupal-fixture.js";

/**
 * What docs/integrations/drupal.md shows for Fernlea Family Clinic (an invented village clinic whose site a freelancer
 * built on Drupal): the settings entry, what the adapter reads over the invented site, and what the Drupal check finds.
 * The docs test compares the page's blocks with these, so the page cannot drift from the tool. To print both for the page:
 * pnpm exec tsx packages/core/src/adapters/__tests__/drupal-docs-example.ts
 */
export const DRUPAL_SETTINGS = {
  id: "drupal",
  fingerprint: { "node--article": ["title", "field_subtitle"], "node--page": ["title"] },
  readUnpublished: true,
} as const;

// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const TOKEN = ["drupal", "docs", "fernlea0123456789abcdef"].join("_");

function world() {
  const fetcher = createFetcher({
    transport: drupalTransport(FERNLEA, {
      credential: { kind: "bearer", token: TOKEN },
      // The article about staff changes is saved and never published, and its page opens for a visitor: the leak the check looks for.
      pages: PAGES_LEAK,
    }),
    timeoutMs: 5000,
  });
  const adapter = createDrupalAdapter({
    env: { DRUPAL_URL: DRUPAL_SITE, DRUPAL_TOKEN: TOKEN },
    fetcher,
    settings: DRUPAL_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  return { fetcher, adapter };
}

export async function drupalReads(): Promise<string> {
  const { adapter } = world();
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("node--article", [
    "title",
    "field_subtitle",
    "field_teaser",
  ]);
  const { docs } = await collectPublished(adapter, { types: ["node--article"] });
  return JSON.stringify(
    {
      types,
      "article fields": fields,
      "drafts reachable": await adapter.draftsReachable(),
      "published articles": docs,
    },
    null,
    2,
  );
}

export async function drupalFindings(): Promise<string> {
  const { adapter, fetcher } = world();
  const reading = await readDrupal({ adapter, fetcher, ownerConsent: true });
  const result = await runChecks(reading, createDrupalRegistry());
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
  void drupalReads().then(async (text) => {
    process.stdout.write(`${text}\n\n${await drupalFindings()}\n`);
  });
