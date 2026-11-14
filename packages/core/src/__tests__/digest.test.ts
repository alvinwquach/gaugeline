import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../fixtures/src/index.js";
import {
  buildDigest,
  daysBetween,
  digestHtml,
  digestMarkdown,
  findingKey,
  safeEvidence,
  verdict,
} from "../digest.js";
import type { Finding } from "../model.js";
import { buildResult, parseResult, type Result } from "../result.js";

const RUNS_DIR = `${SITES_DIR}../runs/digest-week/`;
const week = (): Result[] =>
  readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => parseResult(JSON.parse(readFileSync(`${RUNS_DIR}${f}`, "utf8"))));

const f = (checkId: string, evidence = "e", severity: Finding["severity"] = "medium"): Finding => ({
  checkId,
  severity,
  title: `Title of ${checkId}`,
  evidence,
  url: "https://shop.example/",
});
const run = (at: string, findings: Finding[], passed = ["noindex", "viewport"]): Result =>
  buildResult({
    url: "https://shop.example/",
    startedAt: new Date(at),
    findings,
    passed,
    failed: [],
  });

describe("digest: unit", () => {
  it("a finding's age is whole calendar days in the zone, not elapsed hours", () => {
    const tz = "America/Los_Angeles";
    // 23:30 on Sat 31 Oct to 00:10 on Mon 2 Nov, Pacific: 25 h 40 min elapsed, two calendar days.
    expect(
      daysBetween(new Date("2026-11-01T06:30:00Z"), new Date("2026-11-02T08:10:00Z"), tz),
    ).toBe(2);
    // The same instants in UTC are one calendar day apart.
    expect(
      daysBetween(new Date("2026-11-01T06:30:00Z"), new Date("2026-11-02T08:10:00Z"), "UTC"),
    ).toBe(1);
    expect(
      daysBetween(new Date("2026-11-02T15:00:00Z"), new Date("2026-11-02T23:00:00Z"), "UTC"),
    ).toBe(0);
  });

  it("grouping across runs: new, fixed and still open", () => {
    const d = buildDigest([
      run("2026-11-02T15:00:00Z", [f("a"), f("gone")]),
      run("2026-11-03T15:00:00Z", [f("a"), f("gone")]),
      run("2026-11-04T15:00:00Z", [f("a"), f("fresh")]),
    ]);
    expect(d.newThisWeek.map((i) => i.checkId)).toEqual(["fresh"]);
    expect(d.fixed.map((i) => [i.checkId, i.fixedAt?.toISOString()])).toEqual([
      ["gone", "2026-11-04T15:00:00.000Z"],
    ]);
    expect(d.stillOpen.map((i) => i.checkId)).toEqual(["a"]);
  });

  it("the same finding with different numbers keeps its key; a query string never counts", () => {
    expect(findingKey(f("x", "3 of 12 images"))).toBe(findingKey(f("x", "4 of 13 images")));
    expect(findingKey({ ...f("x"), url: "https://shop.example/?t=1" })).toBe(findingKey(f("x")));
    expect(findingKey(f("x", "a"))).not.toBe(findingKey(f("y", "a")));
  });

  it("evidence in the digest has no query strings and no secrets", () => {
    expect(safeEvidence('<a href="https://shop.example/order?session=abc"> returned 404')).toBe(
      '<a href="https://shop.example/order?…"> returned 404',
    );
    // Built at run time so no key-shaped string is committed.
    const key = "sk_live_" + "51ABCDEFGHIJKLMNOPQRSTUVWX";
    expect(safeEvidence(`key ${key}`)).not.toContain(key);
  });

  it("runs of two sites are refused; runs more than 7 days before the latest are left out", () => {
    expect(() =>
      buildDigest([
        run("2026-11-02T00:00:00Z", []),
        { ...run("2026-11-03T00:00:00Z", []), url: "https://other.example/" },
      ]),
    ).toThrow(
      "The runs are of more than one site (shop.example, other.example): give one site's runs.",
    );
    const d = buildDigest([
      run("2026-10-20T15:00:00Z", [f("old")]),
      run("2026-11-02T15:00:00Z", []),
      run("2026-11-08T15:00:00Z", []),
    ]);
    expect(d.older).toBe(1);
    expect(d.runs).toBe(2);
    expect(d.fixed).toEqual([]);
  });
});

describe("digest: integration (seven recorded runs of the digest-week fixture)", () => {
  it("one new, one fixed and two still open, and the digest matches the saved snapshot", () => {
    const d = buildDigest(week(), { timeZone: "America/Los_Angeles" });
    expect(d.newThisWeek.map((i) => i.checkId)).toEqual(["broken-links"]);
    expect(d.fixed.map((i) => i.checkId)).toEqual(["og-image-missing"]);
    expect(d.stillOpen.map((i) => i.checkId)).toEqual([
      "canonical-elsewhere",
      "images-alt-missing",
    ]);
    expect(verdict(d)).toBe("This week: 1 new thing to fix, 1 fixed and 2 older ones still open.");
    const md = digestMarkdown(d);
    expect(md).toMatchSnapshot("markdown");
    expect(digestHtml(d)).toMatchSnapshot("html");
  });

  it("the plain section has no check ids; the session token never appears", () => {
    const md = digestMarkdown(buildDigest(week(), { timeZone: "America/Los_Angeles" }));
    const [plain = "", technical = ""] = md.split("\n---\n");
    for (const id of [
      "broken-links",
      "og-image-missing",
      "canonical-elsewhere",
      "images-alt-missing",
    ]) {
      expect(plain).not.toContain(id);
      expect(technical).toContain(id);
    }
    const html = digestHtml(buildDigest(week()));
    for (const text of [md, html]) {
      expect(text).not.toContain("session=");
      expect(text).not.toContain("a1b2c3d4");
    }
    expect(html).not.toMatch(/<script|<style|<link|<img/i);
  });
});

describe("digest: edge cases", () => {
  it("a week with only one run: everything is still open and nothing is called new or fixed", () => {
    const d = buildDigest([run("2026-11-08T15:00:00Z", [f("a", "e", "high")])]);
    expect(d.newThisWeek).toEqual([]);
    expect(d.fixed).toEqual([]);
    expect(d.stillOpen.map((i) => i.checkId)).toEqual(["a"]);
    expect(verdict(d)).toBe("One check this week: 1 thing to fix.");
    expect(digestMarkdown(d)).toContain(
      "was checked once, on Sun 8 Nov. 2 things looked right in the latest check. With one check, nothing can be called new or fixed yet.",
    );
  });

  it("a finding that opened and closed mid-week is under fixed, with both dates", () => {
    const d = buildDigest([
      run("2026-11-02T15:00:00Z", []),
      run("2026-11-03T15:00:00Z", [f("blip")]),
      run("2026-11-04T15:00:00Z", [f("blip")]),
      run("2026-11-05T15:00:00Z", []),
    ]);
    expect(d.newThisWeek).toEqual([]);
    expect(d.fixed.map((i) => [i.firstSeen.toISOString(), i.fixedAt?.toISOString()])).toEqual([
      ["2026-11-03T15:00:00.000Z", "2026-11-05T15:00:00.000Z"],
    ]);
    expect(digestMarkdown(d)).toContain(
      "- **Title of blip** (on /, seen Tue 3 Nov, fixed by Thu 5 Nov).",
    );
  });

  it("a week containing a clock change: dates and ages follow the local calendar", () => {
    // US clocks go back on Sunday 1 November 2026. Runs at 00:30 local time each day.
    const d = buildDigest(
      [
        run("2026-10-30T07:30:00Z", [f("a")]), // Fri 30 Oct 00:30 PDT
        run("2026-11-01T07:30:00Z", [f("a")]), // Sun 1 Nov 00:30 PDT
        run("2026-11-02T08:30:00Z", [f("a")]), // Mon 2 Nov 00:30 PST
      ],
      { timeZone: "America/Los_Angeles" },
    );
    const md = digestMarkdown(d);
    expect(md).toContain("open 3 days");
    expect(md).toContain("between Fri 30 Oct and Mon 2 Nov");
  });

  it("an empty week still says something: nothing changed, and how many things agree", () => {
    const d = buildDigest([run("2026-11-02T15:00:00Z", []), run("2026-11-08T15:00:00Z", [])]);
    expect(verdict(d)).toBe("Nothing changed. 2 things still agree.");
    const open = buildDigest([
      run("2026-11-02T15:00:00Z", [f("a")]),
      run("2026-11-08T15:00:00Z", [f("a")]),
    ]);
    expect(verdict(open)).toBe(
      "Nothing changed. 2 things still agree, and 1 thing still needs fixing.",
    );
  });

  it("titles and evidence are escaped in the HTML", () => {
    const evil = { ...f("x", "<img src=x onerror=alert(1)>"), title: "<script>alert(1)</script>" };
    const html = digestHtml(
      buildDigest([run("2026-11-02T15:00:00Z", []), run("2026-11-03T15:00:00Z", [evil])]),
    );
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
