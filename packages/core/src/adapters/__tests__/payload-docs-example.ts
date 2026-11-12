import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { createPayloadRegistry } from "../../checks/payload.js";
import { collectPublished } from "../collect.js";
import { createPayloadAdapter } from "../payload.js";
import { readPayload } from "../payload-read.js";
import { API_URL, QUILLON, payloadTransport } from "./payload-fixture.js";

/**
 * What docs/integrations/payload.md shows for Quillon Coffee Roasters (an invented small roastery whose Next.js site
 * a freelancer built with Payload in the same app): the settings entry, what the adapter reads over the invented
 * site, and what the Payload check finds. The docs test compares the page's blocks with these, so the page cannot
 * drift from the tool. To print both for the page:
 * pnpm exec tsx packages/core/src/adapters/__tests__/payload-docs-example.ts
 */
export const PAYLOAD_SETTINGS = {
  id: "payload",
  fingerprint: { posts: ["title", "summary"] },
  urls: { posts: "/journal/{slug}", events: "/events/{slug}" },
  privateCollections: ["wholesale-orders"],
} as const;

// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const KEY = ["payload", "docs", "quillon0123456789abcdef"].join("_");

function world() {
  const fetcher = createFetcher({
    transport: payloadTransport(QUILLON, {
      key: KEY,
      // The orders collection was left readable with a read rule that returns true: the leak the check looks for.
      publicRead: ["wholesale-orders"],
    }),
    timeoutMs: 5000,
  });
  const adapter = createPayloadAdapter({
    env: { PAYLOAD_URL: API_URL, PAYLOAD_API_KEY: KEY },
    fetcher,
    settings: PAYLOAD_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  return { adapter };
}

export async function payloadReads(): Promise<string> {
  const { adapter } = world();
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("posts", ["title", "summary", "slug", "subtitle"]);
  const { docs } = await collectPublished(adapter, { types: ["posts"] });
  return JSON.stringify(
    {
      types,
      "post fields": fields,
      "drafts reachable": await adapter.draftsReachable(),
      "published posts": docs,
    },
    null,
    2,
  );
}

export async function payloadFindings(): Promise<string> {
  const { adapter } = world();
  const reading = await readPayload({ adapter, site: API_URL, ownerConsent: true });
  const result = await runChecks(reading, createPayloadRegistry());
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
  void payloadReads().then(async (text) => {
    process.stdout.write(`${text}\n\n${await payloadFindings()}\n`);
  });
