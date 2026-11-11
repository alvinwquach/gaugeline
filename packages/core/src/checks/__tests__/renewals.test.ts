import { describe, expect, it } from "vitest";
import type { Certificate } from "../../dns/certificate.js";
import type { CheckContext } from "../../model.js";
import type { CertRead } from "../../renewals/certs.js";
import type { RegistrationRead } from "../../renewals/rdap.js";
import type { Renewals, RuntimesRead } from "../../renewals/reader.js";
import type { TokenRead } from "../../renewals/tokens.js";
import { certificateExpiring } from "../certificate-expiring.js";
import {
  RENEWALS_CHECKS,
  certNameMismatch,
  domainExpired,
  domainExpiresSoon,
  domainStatusHold,
  runtimeDeprecated,
  tokenExpiresSoon,
} from "../renewals.js";
import { page } from "./helpers.js";

const NOW = new Date("2026-11-09T12:00:00Z");
const at = (days: number, hours = 1) =>
  new Date(NOW.getTime() + days * 86_400_000 + hours * 3_600_000).toISOString();
const PAGE = page({ finalUrl: "https://marlowe-bar.example/" });

interface Fake {
  registration?: RegistrationRead;
  certificates?: CertRead[];
  tokens?: TokenRead[];
  runtimes?: RuntimesRead;
}

function fake(f: Fake): Renewals {
  return {
    config: {},
    registration: async () =>
      f.registration ?? { ok: false, domain: "marlowe-bar.example", reason: "not read" },
    certificates: async () => f.certificates ?? [],
    tokens: async () => f.tokens ?? [],
    runtimes: async () => f.runtimes ?? { projects: [], notAsked: "not asked" },
    rows: async () => [],
  };
}

function context(renewals?: Renewals) {
  const notes: { url: string; reason: string }[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    now: () => NOW,
    couldNotCheck: (url, reason) => void notes.push({ url, reason }),
    ...(renewals ? { renewals } : {}),
  };
  return { ctx, notes };
}

const registered = (expiresAt: string | undefined, statuses: string[] = ["active"]): Fake => ({
  registration: {
    ok: true,
    domain: "marlowe-bar.example",
    registration: {
      ...(expiresAt ? { expiresAt } : {}),
      registrar: "Plume Registrar, Inc.",
      statuses,
    },
  },
});

describe("the renewals checks do nothing without --renewals", () => {
  it.each(RENEWALS_CHECKS.map((c) => [c.id, c] as const))(
    "%s finds nothing and notes nothing",
    async (_id, check) => {
      const { ctx, notes } = context();
      expect(await check.run(PAGE, ctx)).toEqual([]);
      expect(notes).toEqual([]);
    },
  );
});

describe("domain-expires-soon: threshold table (injected clock)", () => {
  it.each([
    [45, undefined],
    [30, undefined],
    [29, "medium"],
    [7, "medium"],
    [6, "high"],
    [0, "high"],
  ])("%i days left gives %s", async (days, severity) => {
    const { ctx } = context(fake(registered(at(days))));
    const found = await domainExpiresSoon.run(PAGE, ctx);
    expect(found.map((f) => f.severity)).toEqual(severity ? [severity] : []);
  });

  it("writes the date out and names the registrar", async () => {
    const { ctx } = context(fake(registered("2026-12-03T14:02:11Z")));
    expect(await domainExpiresSoon.run(PAGE, ctx)).toEqual([
      {
        checkId: "domain-expires-soon",
        severity: "medium",
        title: "The domain's registration runs out soon",
        evidence:
          "marlowe-bar.example expires 3 Dec 2026, 24 days (registrar Plume Registrar, Inc.)",
        url: "domain:marlowe-bar.example",
      },
    ]);
  });

  it("leaves an expired domain to domain-expired", async () => {
    const { ctx } = context(fake(registered(at(-2))));
    expect(await domainExpiresSoon.run(PAGE, ctx)).toEqual([]);
  });

  it("is could-not-check, with the reason, when the registry could not be read", async () => {
    const { ctx, notes } = context(
      fake({
        registration: {
          ok: false,
          domain: "marlowe-bar.example",
          reason:
            "the .com registry's RDAP server is rate limiting lookups (HTTP 429). Try again in 120 seconds.",
        },
      }),
    );
    expect(await domainExpiresSoon.run(PAGE, ctx)).toEqual([]);
    expect(notes).toEqual([
      { url: PAGE.finalUrl, reason: expect.stringContaining("Try again in 120 seconds") },
    ]);
  });

  it("is could-not-check when the registry redacts its dates", async () => {
    const { ctx, notes } = context(fake(registered(undefined)));
    expect(await domainExpiresSoon.run(PAGE, ctx)).toEqual([]);
    expect(notes[0]?.reason).toBe("the registry publishes no expiry date for marlowe-bar.example");
  });
});

describe("domain-expired", () => {
  it("is a finding once the date has passed, even by an hour", async () => {
    const { ctx } = context(fake(registered(at(-3, 0))));
    const found = await domainExpired.run(PAGE, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "high",
      evidence:
        "marlowe-bar.example expired 6 Nov 2026, 3 days ago (registrar Plume Registrar, Inc.)",
    });
    const { ctx: hour } = context(fake(registered(at(0, -1))));
    expect(await domainExpired.run(PAGE, hour)).toHaveLength(1);
  });

  it("passes while the date is ahead, and says it could not check with no date", async () => {
    expect(await domainExpired.run(PAGE, context(fake(registered(at(0, 1)))).ctx)).toEqual([]);
    const { ctx, notes } = context(fake(registered(undefined)));
    expect(await domainExpired.run(PAGE, ctx)).toEqual([]);
    expect(notes).toHaveLength(1);
  });
});

describe("domain-status-hold", () => {
  it.each([["client hold"], ["server hold"], ["clientHold"], ["serverHold"]])(
    "finds %s",
    async (status) => {
      const { ctx } = context(fake(registered(at(200), ["client transfer prohibited", status])));
      const found = await domainStatusHold.run(PAGE, ctx);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ severity: "high" });
      expect(found[0]?.evidence).toBe(
        `marlowe-bar.example has the status "${status}", so it does not resolve`,
      );
    },
  );

  it("passes for ordinary statuses, and still reads when the dates are hidden", async () => {
    const ok = registered(undefined, ["client transfer prohibited", "active"]);
    const { ctx, notes } = context(fake(ok));
    expect(await domainStatusHold.run(PAGE, ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });
});

describe("cert-name-mismatch", () => {
  const cert = (names: string[], validTo = at(200)): Certificate => ({
    names,
    validFrom: at(-90),
    validTo,
  });

  it("passes when the certificate names the bare domain and www", async () => {
    const { ctx } = context(
      fake({
        certificates: [
          {
            host: "marlowe-bar.example",
            kind: "cert",
            cert: cert(["marlowe-bar.example", "www.marlowe-bar.example"]),
          },
          {
            host: "www.marlowe-bar.example",
            kind: "cert",
            cert: cert(["marlowe-bar.example", "www.marlowe-bar.example"]),
          },
        ],
      }),
    );
    expect(await certNameMismatch.run(PAGE, ctx)).toEqual([]);
  });

  it("accepts a one-label wildcard", async () => {
    const { ctx } = context(
      fake({
        certificates: [
          { host: "www.marlowe-bar.example", kind: "cert", cert: cert(["*.marlowe-bar.example"]) },
        ],
      }),
    );
    expect(await certNameMismatch.run(PAGE, ctx)).toEqual([]);
  });

  it("finds a www the certificate does not name, with the names it has", async () => {
    const { ctx } = context(
      fake({
        certificates: [
          { host: "marlowe-bar.example", kind: "cert", cert: cert(["marlowe-bar.example"]) },
          {
            host: "www.marlowe-bar.example",
            kind: "name-mismatch",
            names: ["marlowe-bar.example"],
          },
        ],
      }),
    );
    expect(await certNameMismatch.run(PAGE, ctx)).toEqual([
      {
        checkId: "cert-name-mismatch",
        severity: "high",
        title: "The bare domain or www is not covered by the certificate",
        evidence:
          "www.marlowe-bar.example is not covered by its certificate, which names marlowe-bar.example",
        url: "https://www.marlowe-bar.example/",
      },
    ]);
  });

  it("finds a read certificate that does not name its host", async () => {
    const { ctx } = context(
      fake({
        certificates: [
          { host: "marlowe-bar.example", kind: "cert", cert: cert(["www.marlowe-bar.example"]) },
        ],
      }),
    );
    expect(await certNameMismatch.run(PAGE, ctx)).toHaveLength(1);
  });

  it("skips a www that does not exist, and notes one that failed for another reason", async () => {
    const { ctx, notes } = context(
      fake({
        certificates: [
          { host: "www.marlowe-bar.example", kind: "absent" },
          {
            host: "marlowe-bar.example",
            kind: "unreadable",
            reason: "marlowe-bar.example's certificate could not be verified (CERT_HAS_EXPIRED)",
          },
        ],
      }),
    );
    expect(await certNameMismatch.run(PAGE, ctx)).toEqual([]);
    expect(notes).toEqual([
      { url: "https://marlowe-bar.example/", reason: expect.stringContaining("CERT_HAS_EXPIRED") },
    ]);
  });
});

describe("token-expires-soon: threshold table (injected clock)", () => {
  const token = (expiresAt?: string): TokenRead => ({
    provider: "GitHub",
    variable: "GAUGELINE_GITHUB_TOKEN",
    ...(expiresAt ? { expiresAt } : {}),
  });

  it.each([
    [40, undefined],
    [21, undefined],
    [20, "medium"],
    [7, "medium"],
    [6, "high"],
    [-1, "high"],
  ])("%i days left gives %s", async (days, severity) => {
    const { ctx } = context(fake({ tokens: [token(at(days))] }));
    const found = await tokenExpiresSoon.run(PAGE, ctx);
    expect(found.map((f) => f.severity)).toEqual(severity ? [severity] : []);
  });

  it("writes the date out and names the variable, never the token", async () => {
    const { ctx } = context(fake({ tokens: [token("2026-11-26T00:00:00Z")] }));
    const found = await tokenExpiresSoon.run(PAGE, ctx);
    expect(found[0]?.evidence).toBe(
      "The GitHub token (GAUGELINE_GITHUB_TOKEN) expires 26 Nov 2026, 16 days",
    );
  });

  it("lists a token with no expiry once, as could-not-check, never as a finding", async () => {
    const { ctx, notes } = context(fake({ tokens: [token()] }));
    expect(await tokenExpiresSoon.run(PAGE, ctx)).toEqual([]);
    expect(notes).toEqual([
      {
        url: "token:github",
        reason: "no expiry reported for the GitHub token (GAUGELINE_GITHUB_TOKEN)",
      },
    ]);
  });

  it("says no token is set up when none is", async () => {
    const { ctx, notes } = context(fake({ tokens: [] }));
    expect(await tokenExpiresSoon.run(PAGE, ctx)).toEqual([]);
    expect(notes[0]?.reason).toMatch(/GAUGELINE_GITHUB_TOKEN or GAUGELINE_VERCEL_TOKEN/);
  });

  it("notes a token that could not be read, with its reason", async () => {
    const { ctx, notes } = context(
      fake({
        tokens: [
          {
            provider: "Vercel",
            variable: "GAUGELINE_VERCEL_TOKEN",
            failed: "Vercel could not be read: HTTP 403",
          },
        ],
      }),
    );
    expect(await tokenExpiresSoon.run(PAGE, ctx)).toEqual([]);
    expect(notes[0]).toEqual({ url: "token:vercel", reason: "Vercel could not be read: HTTP 403" });
  });
});

describe("runtime-deprecated", () => {
  it("finds a project on a Node.js version Vercel has retired, with the source", async () => {
    const { ctx } = context(
      fake({ runtimes: { projects: [{ project: "marlowe-bar-site", nodeVersion: "18.x" }] } }),
    );
    const found = await runtimeDeprecated.run(PAGE, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "high", url: "vercel:marlowe-bar-site" });
    expect(found[0]?.evidence).toMatch(
      /^Vercel project marlowe-bar-site uses Node\.js 18\.x, which retired 1 Sep 2025, \d+ days ago \(Gaugeline's list, written 11 Nov 2026; source https:\/\/vercel\.com\//,
    );
  });

  it("passes a version with no announced retirement", async () => {
    const { ctx } = context(
      fake({ runtimes: { projects: [{ project: "kiln-coffee", nodeVersion: "22.x" }] } }),
    );
    expect(await runtimeDeprecated.run(PAGE, ctx)).toEqual([]);
  });

  it("is could-not-check when nothing was asked or a project could not be read", async () => {
    const asked = context(
      fake({
        runtimes: {
          projects: [],
          notAsked: "GAUGELINE_VERCEL_TOKEN is not set, so Vercel was not asked",
        },
      }),
    );
    expect(await runtimeDeprecated.run(PAGE, asked.ctx)).toEqual([]);
    expect(asked.notes[0]?.reason).toMatch(/not set/);
    const failed = context(
      fake({ runtimes: { projects: [{ project: "gone", failed: "HTTP 404" }] } }),
    );
    expect(await runtimeDeprecated.run(PAGE, failed.ctx)).toEqual([]);
    expect(failed.notes).toEqual([{ url: "vercel:gone", reason: "HTTP 404" }]);
  });
});

describe("certificate-expiring with --renewals (the existing check, reused)", () => {
  const cert = (names: string[], validTo: string): Certificate => ({
    names,
    validFrom: at(-80),
    validTo,
  });
  const pageWith = (c: Certificate) =>
    page({
      finalUrl: "https://marlowe-bar.example/",
      hops: [
        { url: "https://marlowe-bar.example/", status: 200, headers: {}, ms: 1, certificate: c },
      ],
    });

  it("is unchanged without --renewals", async () => {
    const { ctx } = context();
    const found = await certificateExpiring.run(
      pageWith(cert(["marlowe-bar.example"], at(5))),
      ctx,
    );
    expect(found.map((f) => f.severity)).toEqual(["high"]);
    expect(found[0]?.evidence).toMatch(
      /^The certificate for marlowe-bar\.example expires on 2026-11-14: 5 days left/,
    );
  });

  it("also reads the www certificate when it is a different one, and not the same one twice", async () => {
    const apex = cert(["marlowe-bar.example"], at(60));
    const www = cert(["www.marlowe-bar.example"], at(5));
    const { ctx } = context(
      fake({
        certificates: [
          { host: "marlowe-bar.example", kind: "cert", cert: apex },
          { host: "www.marlowe-bar.example", kind: "cert", cert: www },
        ],
      }),
    );
    const found = await certificateExpiring.run(pageWith(apex), ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "high", url: "https://www.marlowe-bar.example/" });
    const same = context(
      fake({
        certificates: [
          { host: "marlowe-bar.example", kind: "cert", cert: www },
          { host: "www.marlowe-bar.example", kind: "cert", cert: www },
        ],
      }),
    );
    expect(await certificateExpiring.run(pageWith(www), same.ctx)).toHaveLength(1);
  });
});
