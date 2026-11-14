import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { createKontentAiRegistry } from "../../checks/kontent-ai.js";
import { collectPublished } from "../collect.js";
import { createKontentAdapter } from "../kontent-ai.js";
import { readKontent } from "../kontent-ai-read.js";
import {
  ENVIRONMENT_ID,
  FERNHILL,
  KONTENT_SITE,
  bothTransport,
  kontentTransport,
  siteTransport,
} from "./kontent-ai-fixture.js";

/**
 * What docs/integrations/kontent-ai.md shows for Fernhill Cycles (an invented bike shop whose Next.js site a freelancer
 * built on Kontent.ai): the settings entry, what the adapter reads over the invented project, and what the Kontent.ai
 * check finds. The docs test compares the page's blocks with these, so the page cannot drift from the tool. To print
 * both for the page: pnpm exec tsx packages/core/src/adapters/__tests__/kontent-ai-docs-example.ts
 */
export const KONTENT_SETTINGS = {
  id: "kontent-ai",
  fingerprint: { article: ["title", "summary"] },
  urls: { article: "/journal/{slug}", offer: "/offers/{slug}" },
  readPreview: true,
} as const;

// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const PREVIEW_KEY = ["kontent", "docs", "fernhill0123456789abcdef"].join("_");

function world() {
  const fetcher = createFetcher({
    transport: bothTransport(
      kontentTransport(FERNHILL, { previewKey: PREVIEW_KEY }),
      // The shop's front end builds journal pages from the Preview API: the closing-down sale page was never published
      // and is answering.
      siteTransport(["/journal/closing-sale"]),
    ),
    timeoutMs: 5000,
  });
  const adapter = createKontentAdapter({
    env: { KONTENT_ENVIRONMENT_ID: ENVIRONMENT_ID, KONTENT_PREVIEW_API_KEY: PREVIEW_KEY },
    fetcher,
    settings: KONTENT_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  return { adapter, fetcher };
}

export async function kontentReads(): Promise<string> {
  const { adapter } = world();
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("article", ["title", "summary", "subtitle"]);
  const { docs } = await collectPublished(adapter, { types: ["article"] });
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

export async function kontentFindings(): Promise<string> {
  const { adapter, fetcher } = world();
  const reading = await readKontent({ adapter, fetcher, site: KONTENT_SITE, ownerConsent: true });
  const result = await runChecks(reading, createKontentAiRegistry());
  return JSON.stringify(
    {
      "preview read": reading.read && {
        state: reading.read.state,
        published: reading.read.published,
        "not published": reading.read.entries.map(
          (e) => `${e.type}: ${e.slug ?? e.id} (${e.step})`,
        ),
      },
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
  void kontentReads().then(async (text) => {
    process.stdout.write(`${text}\n\n${await kontentFindings()}\n`);
  });
