import { describe, expect, it } from "vitest";
import { buildDigest, digestHtml, digestMarkdown } from "../../digest.js";
import type { Finding } from "../../model.js";
import { createRenewalsRegistry } from "../registry.js";
import { renderReport } from "../../report/html.js";
import { buildResult } from "../../result.js";
import { renewalDate, renewalItems, renewalLine } from "../section.js";

const f = (
  checkId: string,
  severity: Finding["severity"],
  evidence: string,
  url = "domain:marlowe-bar.example",
): Finding => ({ checkId, severity, title: `Title of ${checkId}`, evidence, url });

const DOMAIN = f(
  "domain-expires-soon",
  "medium",
  "marlowe-bar.example expires 3 Dec 2026, 24 days (registrar Plume Registrar, Inc.)",
);
const CERT = f(
  "certificate-expiring",
  "high",
  "The certificate for marlowe-bar.example expires on 2026-11-14: 5 days left (issued by Invented Authority)",
  "https://marlowe-bar.example/",
);
const TOKEN = f(
  "token-expires-soon",
  "medium",
  "The GitHub token (GAUGELINE_GITHUB_TOKEN) expires 19 Nov 2026, 9 days",
  "token:github",
);
const HOLD = f(
  "domain-status-hold",
  "high",
  'marlowe-bar.example has the status "client hold", so it does not resolve',
);
const OTHER = f(
  "noindex",
  "high",
  "noindex on https://marlowe-bar.example/",
  "https://marlowe-bar.example/",
);

describe("the Renewals section: unit", () => {
  it("reads the date from the evidence, written out or as the certificate check writes it", () => {
    expect(renewalDate(DOMAIN.evidence)).toBe("2026-12-03");
    expect(renewalDate(CERT.evidence)).toBe("2026-11-14");
    expect(renewalDate(HOLD.evidence)).toBeUndefined();
  });

  it("keeps only renewal findings, the broken first, then by date, whatever order they came in", () => {
    const items = renewalItems([OTHER, DOMAIN, TOKEN, CERT, HOLD]);
    expect(items.map((i) => i.checkId)).toEqual([
      "domain-status-hold",
      "certificate-expiring",
      "token-expires-soon",
      "domain-expires-soon",
    ]);
    expect(renewalItems([HOLD, CERT, TOKEN, DOMAIN, OTHER]).map((i) => i.checkId)).toEqual(
      items.map((i) => i.checkId),
    );
  });

  it("leads a dated line with the date, written out", () => {
    const [, cert] = renewalItems([HOLD, CERT]);
    expect(cert && renewalLine(cert)).toMatch(
      /^14 Nov 2026: The certificate for marlowe-bar\.example/,
    );
  });
});

describe("the Renewals section: the HTML report and the digest", () => {
  const registry = createRenewalsRegistry();
  const findings = [OTHER, DOMAIN, TOKEN, CERT, HOLD];

  it("is one section in the report, by date, with the dates written out, and findings stay below", () => {
    const result = buildResult({
      url: "https://marlowe-bar.example/",
      startedAt: new Date("2026-11-09T12:00:00Z"),
      findings,
      passed: [],
      failed: [],
    });
    const html = renderReport({
      result: { ...result, failed: [], warnings: [], sampled: {} },
      url: "https://marlowe-bar.example/",
      startedAt: new Date("2026-11-09T12:00:00Z"),
      registry,
      version: "0.1.0",
    });
    expect(html.match(/<h2>Renewals /g)).toHaveLength(1);
    const lines = html
      .slice(html.indexOf("<h2>Renewals "), html.indexOf("</ul>", html.indexOf("<h2>Renewals ")))
      .split("\n")
      .filter((l) => l.startsWith("<li>"))
      .map((l) => l.replace(/<[^>]+>/g, ""));
    expect(lines).toEqual([
      "Fix this first: marlowe-bar.example has the status &quot;client hold&quot;, so it does not resolve",
      "Fix this first: 14 Nov 2026: The certificate for marlowe-bar.example expires on 2026-11-14: 5 days left (issued by Invented Authority)",
      "Fix soon: 19 Nov 2026: The GitHub token (GAUGELINE_GITHUB_TOKEN) expires 19 Nov 2026, 9 days",
      "Fix soon: 3 Dec 2026: marlowe-bar.example expires 3 Dec 2026, 24 days (registrar Plume Registrar, Inc.)",
    ]);
    expect(html).toContain("<h2>Fix this first <span>3</span></h2>");
  });

  it("has no Renewals heading when nothing lapses", () => {
    const result = buildResult({
      url: "https://marlowe-bar.example/",
      startedAt: new Date("2026-11-09T12:00:00Z"),
      findings: [OTHER],
      passed: [],
      failed: [],
    });
    const html = renderReport({
      result: { ...result, failed: [], warnings: [], sampled: {} },
      url: "https://marlowe-bar.example/",
      startedAt: new Date("2026-11-09T12:00:00Z"),
      registry,
      version: "0.1.0",
    });
    expect(html).not.toContain("Renewals");
  });

  it("is one section in the digest, soonest first, and out of the lists below it", () => {
    const run = (at: string) =>
      buildResult({
        url: "https://marlowe-bar.example/",
        startedAt: new Date(at),
        findings,
        passed: ["noindex"],
        failed: [],
      });
    const d = buildDigest([run("2026-11-08T12:00:00Z"), run("2026-11-09T12:00:00Z")], { registry });
    const md = digestMarkdown(d);
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual([
      "## Renewals",
      "## Still open",
      "## What was checked",
      "## Technical notes",
    ]);
    const renewals = md.slice(md.indexOf("## Renewals"), md.indexOf("## Still open"));
    const lead = renewals
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => /\*\*(.*?)\*\*/.exec(l)?.[1]);
    expect(lead).toEqual([
      "Title of domain-status-hold",
      "Title of certificate-expiring",
      "Title of token-expires-soon",
      "Title of domain-expires-soon",
    ]);
    const stillOpen = md.slice(md.indexOf("## Still open"), md.indexOf("## What was checked"));
    expect(stillOpen).toContain("Title of noindex");
    expect(stillOpen).not.toContain("Title of domain-expires-soon");
    expect(digestHtml(d)).toContain(">Renewals</h2>");
  });
});
