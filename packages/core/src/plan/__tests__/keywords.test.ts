import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { checkKeywords, keywordKey, secondaryTerms } from "../keywords.js";
import { readPlan, type PlanRow } from "../read.js";

const PLANS = `${SITES_DIR}../plans/`;
const row = (
  line: number,
  url: string,
  primary?: string,
  secondary?: string,
  raw: Record<string, string> = {},
): PlanRow => {
  const hash = url.indexOf("#");
  return {
    line,
    url,
    path: hash >= 0 ? url.slice(0, hash) : url,
    ...(hash >= 0 ? { fragment: url.slice(hash + 1) } : {}),
    ...(primary !== undefined ? { primaryKeyword: primary } : {}),
    ...(secondary !== undefined ? { secondaryKeyword: secondary } : {}),
    raw,
  };
};
const found = (rows: PlanRow[]) => checkKeywords(rows).map((f) => [f.checkId, f.evidence]);

describe("keywords: unit", () => {
  it("keywordKey: placeholders and empty cells are no keyword; spacing and case don't matter", () => {
    expect(keywordKey("(branded news)")).toBeUndefined();
    expect(keywordKey("n/a")).toBeUndefined();
    expect(keywordKey("")).toBeUndefined();
    expect(keywordKey(" Medical  Billing Services ")).toBe("medical billing services");
    expect(keywordKey("medical billing services.")).toBe("medical billing services");
  });

  it("a primary group of 3 rows is one finding listing 3 lines", () => {
    expect(
      found([row(2, "/a", "billing"), row(3, "/b", "Billing"), row(4, "/c", "billing ")]),
    ).toEqual([["plan-keyword-cannibalisation", '"billing" is the primary keyword of 3 pages']]);
  });

  it("overlap: A's primary as B's secondary is one low finding; both primary is one medium and no low", () => {
    expect(found([row(2, "/a", "billing"), row(3, "/b", "coding", "billing")])).toEqual([
      ["plan-keyword-overlap", '"billing" is the primary for line 2 and a secondary for line 3'],
    ]);
    expect(found([row(2, "/a", "billing"), row(3, "/b", "billing", "billing")])).toEqual([
      ["plan-keyword-cannibalisation", '"billing" is the primary keyword of 2 pages'],
    ]);
  });

  it("a secondary cell with several terms is split and indexed per term", () => {
    expect(secondaryTerms("billing; coding, audits\nclaims")).toEqual([
      "billing",
      "coding",
      "audits",
      "claims",
    ]);
    expect(found([row(2, "/a", "claims"), row(3, "/b", "x", "billing; claims")])).toEqual([
      ["plan-keyword-overlap", '"claims" is the primary for line 2 and a secondary for line 3'],
    ]);
  });
});

describe("keywords: integration (the invented keywords plan)", () => {
  const plan = () => readPlan(readFileSync(`${PLANS}keywords.csv`, "utf8"));

  it("groups sorted by Primary Volume, a volume that isn't a number last and shown as written", () => {
    expect(checkKeywords(plan().rows).map((f) => [f.checkId, f.evidence])).toEqual([
      [
        "plan-keyword-cannibalisation",
        '"medical billing services" (volume 590) is the primary keyword of 3 pages',
      ],
      [
        "plan-keyword-cannibalisation",
        '"patient payments" (volume 210) is the primary keyword of 2 pages',
      ],
      [
        "plan-keyword-cannibalisation",
        '"credentialing services" (volume n/a (<10)) is the primary keyword of 2 pages',
      ],
      [
        "plan-keyword-overlap",
        '"medical billing companies" (volume 90) is the primary for line 12 and a secondary for line 3',
      ],
      [
        "plan-keyword-overlap",
        '"coding audits" (volume 30) is the primary for line 14 and a secondary for line 6',
      ],
    ]);
  });

  it("placeholders and a page with its anchor row never form a group; each line is listed once", () => {
    const evidence = checkKeywords(plan().rows)
      .map((f) => f.evidence)
      .join("\n");
    expect(evidence).not.toMatch(/branded news|"n\/a"|"medical coding"/);
    for (const f of checkKeywords(plan().rows)) {
      const lines = [...f.evidence.matchAll(/lines? ([\d, and]+)/g)].flatMap(
        (m) => m[1]?.match(/\d+/g) ?? [],
      );
      expect(new Set(lines).size).toBe(lines.length);
    }
  });
});

describe("keywords: edge cases", () => {
  it("singular and plural are different keywords (no stemming)", () => {
    expect(
      found([row(2, "/a", "medical billing company"), row(3, "/b", "medical billing companies")]),
    ).toEqual([]);
  });

  it("a trailing full stop or a different case is the same keyword", () => {
    expect(found([row(2, "/a", "Claims."), row(3, "/b", "claims")])).toHaveLength(1);
  });

  it("one row whose primary and secondary are the same: no finding", () => {
    expect(found([row(2, "/a", "claims", "claims")])).toEqual([]);
  });

  it("a secondary two rows share that neither has as primary: no finding", () => {
    expect(found([row(2, "/a", "x", "statements"), row(3, "/b", "y", "statements")])).toEqual([]);
  });

  it("a plan with no keyword column gives no findings", () => {
    expect(checkKeywords(readPlan("URL\n/a\n/b\n").rows)).toEqual([]);
  });

  it("5,000 rows complete in under a second", () => {
    const rows = Array.from({ length: 5000 }, (_, i) =>
      row(i + 2, `/p/${i}`, `kw ${i % 2500}`, `kw ${(i + 7) % 2500}`),
    );
    const start = performance.now();
    const out = checkKeywords(rows);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(out.filter((f) => f.checkId === "plan-keyword-cannibalisation")).toHaveLength(2500);
  });
});
