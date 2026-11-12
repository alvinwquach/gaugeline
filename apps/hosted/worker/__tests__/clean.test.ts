/**
 * Unit: what the worker does to page text before it is stored. A key-shaped or NUL string in a finding
 * must never stop a site's night: the string is cleaned, the finding stays. Keys are built at run time
 * (GitHub push protection rejects key-shaped literals).
 */
import { describe, expect, it } from "vitest";
import { secretsInValue } from "@gaugeline/core";
import type { Upload, UploadFinding } from "../../lib/api/schema.js";
import { cleanFindings, cleanReason, REMOVED, scrubSecrets, stripNul } from "../clean.js";

const stripe = ["sk", "live", "Zx81Qw".repeat(4)].join("_");
const stripeWithUnderscores = ["sk", "live", "Zx81_Qw41", "Rt52_Yu63", "Io74_Pl85"].join("_");
const assignment = `apiKey: "${["aB3dE5gH7jK9", "mN1pQ3sT5vX7", "zA9cF2hJ4kL6"].join("")}"`;

const finding = (over: Partial<UploadFinding> = {}): UploadFinding => ({
  checkId: "broken-links",
  severity: "high",
  title: "Broken link to the menu",
  evidence: "/menu links to /drinks (404)",
  url: "https://tidewater-bar.test/menu",
  fingerprint: "0123456789abcdef",
  ...over,
});
const upload = (findings: UploadFinding[]): Upload => ({
  schema: 2,
  url: "https://tidewater-bar.test/",
  startedAt: "2026-11-12T03:00:00.000Z",
  findings,
  summary: { total: findings.length },
});

describe("scrubSecrets", () => {
  it("replaces a key in a query string, with or without underscores in the key", () => {
    for (const key of [stripe, stripeWithUnderscores]) {
      const out = scrubSecrets(`/pay?k=${key}&x=1`);
      expect(out.text).toBe(`/pay?k=${REMOVED}&x=1`);
      expect(out.removed).toBe(1);
      expect(secretsInValue(out.text)).toEqual([]);
    }
  });

  it("replaces a bearer token and a secret assignment, and leaves the words around them", () => {
    const bearer = `Bearer ${"Ab1Cd2Ef3Gh4".repeat(3)}`;
    const out = scrubSecrets(`sent ${bearer} then ${assignment}; done`);
    expect(out.text).toBe(`sent ${REMOVED} then apiKey: "${REMOVED}"; done`);
    expect(out.removed).toBe(2);
  });

  it("leaves ordinary text alone", () => {
    expect(scrubSecrets("Opening hours, 7 days a week")).toEqual({
      text: "Opening hours, 7 days a week",
      removed: 0,
    });
  });
});

describe("stripNul", () => {
  it("removes U+0000 from every string and key at any depth", () => {
    const nul = String.fromCharCode(0);
    expect(stripNul({ [`a${nul}`]: [`x${nul}y`, { b: `${nul}c` }], n: 1 })).toEqual({
      a: ["xy", { b: "c" }],
      n: 1,
    });
  });
});

describe("cleanReason", () => {
  it("is N17-clean and has no key", () => {
    const dirty = `\u001b[31mRED\u001b[0m \u202Eevil\u202C ${String.fromCodePoint(0xe0041, 0xe0042)} ${stripe}`;
    const out = cleanReason(dirty);
    const hidden = [...out.text].filter((c) => c.charCodeAt(0) < 32 || "\u202E\u202C".includes(c));
    expect(hidden).toEqual([]);
    expect(out.text).not.toContain(stripe);
    expect(out.text).toContain(REMOVED);
    expect(out.text).toContain("RED");
  });
});

describe("cleanFindings", () => {
  it("cleans title, evidence and url, keeps the finding and its fingerprint, and counts the fields", () => {
    const u = upload([
      finding({
        title: `Pay link ${stripe}`,
        evidence: `token ${stripe} in ${assignment}`,
        url: `https://tidewater-bar.test/pay?k=${stripeWithUnderscores}`,
      }),
      finding({ checkId: "headings", title: "Fine" }),
    ]);
    const n = cleanFindings(u);
    expect(n).toBe(3);
    expect(u.findings).toHaveLength(2);
    expect(u.findings[0]!.fingerprint).toBe("0123456789abcdef");
    expect(u.findings[0]!.url).toBe(`https://tidewater-bar.test/pay?k=${REMOVED}`);
    expect(secretsInValue(u)).toEqual([]);
    expect(u.findings[1]!.title).toBe("Fine");
  });

  it("shows control characters, bidi and tag characters as the N17 helpers do", () => {
    const u = upload([
      finding({
        evidence: `\u001b[31mRED\u001b[0m \u202Eevil\u202C ${String.fromCodePoint(0xe0041, 0xe0042)}`,
        url: "https://tidewater-bar.test/a\u202Eb",
      }),
    ]);
    cleanFindings(u);
    expect(u.findings[0]!.evidence).toBe("\\u{1B}[31mRED\\u{1B}[0m evil");
    expect(u.findings[0]!.url).toBe("https://tidewater-bar.test/ab");
  });

  it("a field that still trips the scan after cleaning loses its evidence and url, not the finding", () => {
    const u = upload([
      finding({ evidence: "STUBBORN", url: "https://tidewater-bar.test/STUBBORN" }),
    ]);
    // A stand-in scan that no cleaning can satisfy for the marker word.
    const scan = (v: unknown) => (JSON.stringify(v).includes("STUBBORN") ? ["stub"] : []);
    const n = cleanFindings(u, scan);
    expect(n).toBe(1);
    expect(u.findings).toHaveLength(1);
    expect(u.findings[0]).toMatchObject({
      evidence: "",
      url: "https://tidewater-bar.test/",
      title: "Broken link to the menu",
      fingerprint: "0123456789abcdef",
    });
  });
});
