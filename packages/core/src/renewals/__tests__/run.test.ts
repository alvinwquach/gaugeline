import { describe, expect, it } from "vitest";
import type { Certificate } from "../../dns/certificate.js";
import { createFetcher } from "../../fetcher.js";
import { createRenewalsRegistry } from "../registry.js";
import { RENEWALS_CHECKS } from "../../checks/renewals.js";
import { buildResult } from "../../result.js";
import { checkSite } from "../../site.js";
import { createRenewals } from "../reader.js";
import { renewalItems, renewalLine } from "../section.js";
import { GITHUB_TOKEN_VAR, VERCEL_TOKEN_VAR } from "../tokens.js";
import { bootstrapFor, COM_DOMAIN } from "./rdap-fixtures.js";
import { fakeKey, recordedTransport, type Recorded } from "./recorded.js";

const NOW = new Date("2026-11-09T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000 + 3_600_000).toISOString();
const GH = fakeKey("github", "_pat_", "TESTONLY", "run001");
const VC = fakeKey("vercel", "-test-", "token", "run002");

const cert = (names: string[], validTo: string): Certificate => ({
  names,
  validFrom: day(-80),
  validTo,
  issuer: "Invented Authority",
});

/** What marlowe-bar.com (a bar) serves, and what the services around it answer. All invented. */
function marlowe(over: Record<string, Recorded> = {}) {
  const apex = cert(["marlowe-bar.com"], day(5));
  const altname = Object.assign(new Error("Hostname/IP does not match certificate's altnames"), {
    code: "ERR_TLS_CERT_ALTNAME_INVALID",
    cert: {
      subjectaltname: "DNS:marlowe-bar.com",
      subject: { CN: "marlowe-bar.com" },
      valid_to: new Date(apex.validTo).toUTCString(),
    },
  });
  return recordedTransport({
    "GET https://marlowe-bar.com/": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<!doctype html><title>Marlowe Bar</title><h1>Marlowe Bar</h1>",
      certificate: apex,
    },
    "HEAD https://marlowe-bar.com/": { status: 200, certificate: apex },
    "HEAD https://www.marlowe-bar.com/": { status: 0, fail: altname },
    "GET https://data.iana.org/rdap/dns.json": {
      status: 200,
      body: bootstrapFor("https://rdap.registry.example", { com: "/com/v1/" }),
    },
    "GET https://rdap.registry.example/com/v1/domain/marlowe-bar.com": {
      status: 200,
      body: {
        ...COM_DOMAIN,
        status: ["client transfer prohibited"],
        events: [{ eventAction: "expiration", eventDate: "2026-12-03T14:02:11Z" }],
      },
    },
    "GET https://api.github.com/rate_limit": {
      status: 200,
      headers: { "github-authentication-token-expiration": "2026-11-19 00:00:00 UTC" },
      body: {},
    },
    "GET https://api.vercel.com/v5/user/tokens/current": {
      status: 200,
      body: { token: { id: "t" } },
    },
    "GET https://api.vercel.com/v9/projects/marlowe-bar-site": {
      status: 200,
      body: { nodeVersion: "18.x" },
    },
    ...over,
  });
}

async function run(over: Record<string, Recorded> = {}, env: Record<string, string> = {}) {
  const { transport, seen } = marlowe(over);
  const fetcher = createFetcher({ transport });
  const renewals = createRenewals(
    {
      config: { vercel: { projects: ["marlowe-bar-site"] } },
      env: { [GITHUB_TOKEN_VAR]: GH, [VERCEL_TOKEN_VAR]: VC, ...env },
    },
    fetcher,
  );
  const registry = createRenewalsRegistry();
  const check = await checkSite({
    address: "marlowe-bar.com",
    fetcher,
    registry,
    only: ["certificate-expiring", ...RENEWALS_CHECKS.map((c) => c.id)],
    renewals,
    now: () => NOW,
  });
  return { check, renewals, seen };
}

describe("renewals: integration (recorded responses)", () => {
  it("finds every lapsing thing on one run, soonest first, and asks only GET or HEAD", async () => {
    const { check, seen } = await run();
    const f = check.result.findings;
    expect(f.map((x) => [x.checkId, x.severity])).toEqual([
      ["certificate-expiring", "high"],
      ["cert-name-mismatch", "high"],
      ["runtime-deprecated", "high"],
      ["domain-expires-soon", "medium"],
      ["token-expires-soon", "medium"],
    ]);
    const evidence = Object.fromEntries(f.map((x) => [x.checkId, x.evidence]));
    expect(evidence["domain-expires-soon"]).toBe(
      "marlowe-bar.com expires 3 Dec 2026, 24 days (registrar Plume Registrar, Inc.)",
    );
    expect(evidence["token-expires-soon"]).toBe(
      "The GitHub token (GAUGELINE_GITHUB_TOKEN) expires 19 Nov 2026, 9 days",
    );
    expect(evidence["cert-name-mismatch"]).toBe(
      "www.marlowe-bar.com is not covered by its certificate, which names marlowe-bar.com",
    );
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET", "HEAD"]));
    // The page, both hosts' certificates, the bootstrap file, the registry, two tokens and one project.
    expect(seen.map((s) => `${s.method} ${s.url}`).sort()).toEqual(
      [
        "GET https://marlowe-bar.com/",
        "HEAD https://marlowe-bar.com/",
        "HEAD https://www.marlowe-bar.com/",
        "GET https://data.iana.org/rdap/dns.json",
        "GET https://rdap.registry.example/com/v1/domain/marlowe-bar.com",
        "GET https://api.github.com/rate_limit",
        "GET https://api.vercel.com/v5/user/tokens/current",
        "GET https://api.vercel.com/v9/projects/marlowe-bar-site",
      ].sort(),
    );
  });

  it("lists a token with no expiry as could-not-check, not a finding", async () => {
    const { check } = await run();
    expect(check.result.couldNotCheck).toContainEqual({
      id: "token-expires-soon",
      reason: "no expiry reported for the Vercel token (GAUGELINE_VERCEL_TOKEN)",
      url: "token:vercel",
    });
  });

  it("sorts the Renewals section by date, the broken first, with the dates written out", async () => {
    const { check } = await run();
    const items = renewalItems(check.result.findings);
    expect(items.map((i) => [i.checkId, i.date])).toEqual([
      ["cert-name-mismatch", undefined],
      ["runtime-deprecated", "2025-09-01"],
      ["certificate-expiring", expect.stringMatching(/^2026-11-1\d$/)],
      ["token-expires-soon", "2026-11-19"],
      ["domain-expires-soon", "2026-12-03"],
    ]);
    expect(renewalLine(items[4]!)).toBe(
      "3 Dec 2026: marlowe-bar.com expires 3 Dec 2026, 24 days (registrar Plume Registrar, Inc.)",
    );
  });

  it("gives the rows for the section: every date read, healthy or not", async () => {
    const { renewals } = await run();
    const rows = await renewals.rows(NOW);
    expect(rows.map((r) => [r.kind, r.subject, r.date?.slice(0, 10), r.level])).toEqual([
      ["certificate", "www.marlowe-bar.com", undefined, "first"],
      ["runtime", "Vercel project marlowe-bar-site, Node.js 18.x", "2025-09-01", "first"],
      ["certificate", "marlowe-bar.com", "2026-11-14", "first"],
      ["token", "GitHub token (GAUGELINE_GITHUB_TOKEN)", "2026-11-19", "soon"],
      ["domain", "marlowe-bar.com", "2026-12-03", "soon"],
      ["token", "Vercel token (GAUGELINE_VERCEL_TOKEN)", undefined, "unknown"],
    ]);
  });

  it("never puts a token in the result, a finding or a reason", async () => {
    const { check } = await run({
      "GET https://api.vercel.com/v9/projects/marlowe-bar-site": {
        status: 403,
        body: { error: { message: VC } },
      },
    });
    const json = JSON.stringify(
      buildResult({
        url: "https://marlowe-bar.com/",
        startedAt: NOW,
        findings: check.result.findings,
        passed: check.result.passed,
        failed: [],
        couldNotCheck: check.result.couldNotCheck,
        sampled: check.result.sampled,
      }),
    );
    expect(json).not.toContain(VC);
    expect(json).not.toContain(GH);
    expect(check.result.couldNotCheck.some((c) => c.id === "runtime-deprecated")).toBe(true);
  });

  it("is could-not-check for a ccTLD with no RDAP, and the rest still runs", async () => {
    const { check } = await run({
      "GET https://data.iana.org/rdap/dns.json": {
        status: 200,
        body: bootstrapFor("https://rdap.registry.example", { net: "/net/v1/" }),
      },
    });
    expect(check.result.findings.map((f) => f.checkId)).not.toContain("domain-expires-soon");
    expect(
      check.result.couldNotCheck.filter((c) => c.id.startsWith("domain-")).map((c) => c.id),
    ).toEqual(["domain-expires-soon", "domain-expired", "domain-status-hold"]);
    expect(check.result.couldNotCheck.find((c) => c.id === "domain-expired")?.reason).toMatch(
      /\.com has no RDAP service/,
    );
    expect(check.result.findings.map((f) => f.checkId)).toContain("cert-name-mismatch");
  });

  it("asks for no token and no project that was not set up", async () => {
    const { transport, seen } = marlowe();
    const fetcher = createFetcher({ transport });
    const renewals = createRenewals({ config: {}, env: {} }, fetcher);
    const check = await checkSite({
      address: "marlowe-bar.com",
      fetcher,
      registry: createRenewalsRegistry(),
      only: ["token-expires-soon", "runtime-deprecated"],
      renewals,
      now: () => NOW,
    });
    expect(seen.filter((s) => s.url.includes("api."))).toEqual([]);
    expect(check.result.couldNotCheck.map((c) => c.reason)).toEqual([
      "no token is set up (set GAUGELINE_GITHUB_TOKEN or GAUGELINE_VERCEL_TOKEN to check one)",
      'no Vercel project is listed under "vercel" in gaugeline.renewals.json',
    ]);
  });

  it("a platform address has no registration of the client's to check", async () => {
    const { transport } = recordedTransport({
      "GET https://kiln-pop-up.vercel.app/": {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<title>Kiln pop-up</title>",
      },
    });
    const fetcher = createFetcher({ transport });
    const check = await checkSite({
      address: "kiln-pop-up.vercel.app",
      fetcher,
      registry: createRenewalsRegistry(),
      only: ["domain-expires-soon"],
      renewals: createRenewals({ config: {}, env: {} }, fetcher),
      now: () => NOW,
    });
    expect(check.result.findings).toEqual([]);
    expect(check.result.couldNotCheck[0]?.reason).toMatch(
      /address on vercel\.app, which owns the domain/,
    );
  });
});
