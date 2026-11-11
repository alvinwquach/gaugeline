import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPageRegistry } from "@gaugeline/core";
import { SITES_DIR, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

const MAP_HOSTS = fileURLToPath(new URL("./helpers/map-hosts.cjs", import.meta.url));

/** Every fixture whose findings, together, should cover the catalogue. */
const FIXTURES = [
  "quick-start",
  "duplicate-host",
  "noindex-header",
  "redirect-chain",
  "thin-html",
  "weight",
  "sitemap-feeds",
  "ai-blanket",
  "ai-explicit",
  "llms-stale",
  "ai-agents",
  "links",
  "images",
  "assorted",
  "venue",
  "content-hygiene",
  "northwind",
  "schema-drift",
  "bilingual-popup",
  "bilingual-drift",
  "popup",
  "payments-popup",
  "payments-drift",
  "leaks",
  "launch-preview",
  "preview-host",
  "paged-list",
  "load-more",
  "hidden-library",
  "next-like",
  "gatsby-like",
  "gatsby-dev",
  "sveltekit-like",
  "sveltekit-dev",
  "astro-like",
  "sanity-images",
  "refusing",
  "tag-rules",
  "nav-events",
  "nav-after",
  "tampered",
  "stripe-test-mode",
  "form-checks",
  "paid-downloads",
  "gated-downloads",
  "checkout-after",
];

/**
 * The App Store and Google Play checks answer by asking apple.com and google.com over HTTPS. Tests
 * never use the live internet, so those three are confirmed in-process against recorded answers
 * (packages/cli/src/__tests__/app-store-links.test.ts), not through the built bin.
 */
const NEEDS_LIVE_STORES = new Set([
  "app-link-dead",
  "app-name-mismatch",
  "app-smart-banner-mismatch",
  // Cash App and Venmo profiles: confirmed in-process with stubbed hosts (facts.test.ts).
  "facts-payment-link",
  // Square and Stripe payment links: confirmed in-process against the payment-links cassette.
  "payment-link-dead",
  // Sanity's query API: confirmed in-process against the sanity-datasets cassette (leaks.test.ts).
  "dataset-public",
  "dataset-private-types",
  // The configured database project: confirmed in-process against the supabase-access cassette.
  "access-public-read",
  "access-role-scope",
  // The CRM lead checks read Salesforce through its MCP server and run only with a gaugeline.crm.json;
  // confirmed in-process against recorded answers (checks/__tests__/crm.test.ts, cli crm.test.ts).
  "crm-field-names",
  "crm-lead-source",
  "crm-went-quiet",
  // Listings: they compare Google, Yelp and Apple listings with the site and run only with a
  // gaugeline.listings.json; confirmed in-process against recorded answers (listings.test.ts,
  // packages/core/src/checks/__tests__/listings.test.ts).
  "listing-address-mismatch",
  "listing-hours-mismatch",
  "listing-name-mismatch",
  "listing-phone-mismatch",
  "listing-special-hours-missing",
  "listing-website-wrong",
  // Data assertions: they run SELECTs in gaugeline.sources.json against a database, and run only
  // when the file holds assertions; confirmed in-process against a stand-in Postgres
  // (assert.test.ts) and a real throwaway one (core assertions/__tests__/examples.test.ts).
  "data-assertion-failed",
  // Switches, the 86 list and capacity: they compare the site with Sanity and a database named in
  // gaugeline.switches.json, and run only when the file is there; confirmed in-process against a
  // recorded Sanity answer and a stand-in Postgres (core switches/__tests__/integration.test.ts,
  // cli switches.test.ts).
  "switch-off-still-linked",
  "switch-page-wrong",
  "item-unavailable-shown",
  "capacity-zero-not-sold-out",
  // Data freshness: the checks run only with gaugeline.freshness.json; confirmed in-process against
  // fixture pages, an injected clock and a stand-in Postgres (core checks/__tests__/freshness.test.ts,
  // freshness/__tests__/integration.test.ts, cli freshness.test.ts).
  "data-stale",
  "data-no-stamp",
  "data-behind-source",
  "forecast-for-past-event",
  // Content model: the checks run only with gaugeline.model.json and ask a Sanity dataset for counts
  // and ids; confirmed in-process against the invented clinic site and dataset (core
  // content-model/__tests__/integration.test.ts, cli model.test.ts).
  "model-missing-required",
  "model-unexpanded",
  "model-listing-count",
  "model-dependents",
  "model-orphan-fields",
  // Public DNS: the built-bin run resolves nothing; confirmed in-process with a fake reader.
  "email-dmarc-missing",
  "email-dmarc-none",
  "email-spf-missing",
  "email-spf-multiple",
  // Needs a content source (branch 30): until then it is never run.
  "next-stale-after-publish",
  // Need a rendered read to click anything (G39): confirmed in-process with a recorded observer
  // (packages/core/src/checks/__tests__/click-events.test.ts).
  "events-fire",
  "events-distinct",
  // Need two runs with --since last: confirmed in-process (since.test.ts).
  "price-changed",
  "form-provider-changed",
  "form-destination-changed",
  // Needs an https page with an http form, iframe or script on it; the fixture servers are plain
  // http, so nothing on them is mixed content. Confirmed in-process (core checks/__tests__/forms.test.ts).
  "crm-insecure",
  // A menu compared with the last run's: confirmed in-process (nav.test.ts, nav-before then nav-after).
  "nav-changed",
  // A page's third-party scripts and security headers compared with the last run's: confirmed in-process
  // (core checks/__tests__/script-baseline.test.ts) and end to end (script-baseline.test.ts, checkout-before
  // then checkout-after). script-known-bad-host needs no earlier run and fires on checkout-after.
  "script-changed",
  "csp-loosened",
  "security-header-loosened",
  // A page compared with its own last-run snapshot: confirmed in-process (snapshot.test.ts,
  // snap-before then snap-after) and end to end (page-snapshots.test.ts).
  "page-gone",
  "page-lost-content",
  "page-lost-items",
  "page-lost-structured-data",
  // Needs an https certificate near expiry; the fixture servers are plain http. Confirmed
  // in-process over a local https server with a 5-day certificate (dns/__tests__/cutover.test.ts).
  "certificate-expiring",
  // Need a Next.js page answering RSC: 1; confirmed in-process on the rsc-app fixture
  // (verify/__tests__/recheck.test.ts) and end to end by gaugeline verify (verify.test.ts).
  "rsc-served-as-page",
  "rsc-vary-missing",
  // These read the site's other host (www, staging). Here every fixture host resolves to 127.0.0.1,
  // and with --allow-private only the typed host and port may be private (the address policy), so
  // the stand-in "public" hosts are refused. Confirmed in-process, where the fetcher's hosts map
  // marks them as stand-ins (runner.test.ts duplicate-host, launch tests for staging-indexable).
  "host-duplicate",
  "staging-indexable",
]);

async function findingsOf(name: string): Promise<string[]> {
  const site = await startFixture(name);
  try {
    // The fixtures' event dates are fixed, so the run's clock is too (the preload pins Date).
    const env: NodeJS.ProcessEnv = {
      NODE_OPTIONS: `--require=${MAP_HOSTS}`,
      GAUGELINE_TEST_NOW: "2026-11-05T20:00:00Z",
      // Nothing but the mapped fixture hosts resolves: no live request can leave this test.
      GAUGELINE_TEST_OFFLINE: "1",
    };
    if (Object.keys(site.hosts).length > 0) env.GAUGELINE_TEST_HOSTS = JSON.stringify(site.hosts);
    // A fixture with a schema guide is run from its own folder, where the CLI looks for it.
    const dir = `${SITES_DIR}${name}`;
    const cwd = [
      "gaugeline.schema.json",
      "gaugeline.languages.json",
      "gaugeline.facts.json",
      "gaugeline.payments.json",
      "gaugeline.hidden.json",
      "gaugeline.tags.json",
      "gaugeline.events.json",
      "gaugeline.nav.json",
      "gaugeline.ai.json",
      // The owner's agreement to the probing checks: this fixture's download route is asked.
      "gaugeline.consent.json",
    ].some((f) => existsSync(`${dir}/${f}`))
      ? dir
      : undefined;
    const r = await runBin([site.origin, "--json", "--allow-private"], env, cwd ? { cwd } : {});
    expect(r.status, `${name}: ${r.stderr}`).toBe(0);
    const json = JSON.parse(r.stdout) as { findings: { checkId: string }[] };
    return json.findings.map((f) => f.checkId);
  } finally {
    await site.close();
  }
}

describe("every merged check fires: e2e (the built bin at its package version, over the fixtures)", () => {
  it("the fixtures' findings together cover every registered check", async () => {
    const fired = new Map<string, string[]>();
    for (const name of FIXTURES) {
      for (const id of await findingsOf(name)) fired.set(id, [...(fired.get(id) ?? []), name]);
    }
    const expected = createPageRegistry()
      .all()
      .map((c) => c.id)
      .filter((id) => !NEEDS_LIVE_STORES.has(id))
      .sort();
    expect([...fired.keys()].filter((id) => !NEEDS_LIVE_STORES.has(id)).sort()).toEqual(expected);
  }, 120_000);
});
