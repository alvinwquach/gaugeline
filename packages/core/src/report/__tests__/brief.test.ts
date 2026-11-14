import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogue } from "../../catalogue.js";
import {
  AD_LANDING_CHECKS,
  CAMPAIGN_CHECKS,
  CUTOVER_ONLY_CHECKS,
  DUPLICATE_CHECKS,
  GRAPHQL_CHECKS,
  MUTATION_CHECKS,
  PLAN_CHECKS,
  PRESENCE_CHECKS,
  PRICE_CHECKS,
  PRINTED_CHECKS,
  QUERY_CHECKS,
  QUERY_DUPE_CHECKS,
  QUERY_GENERATED_CHECKS,
  QUERY_UNUSED_CHECKS,
  RECEIPT_CHECKS,
  ROUTE_CHECKS,
  SUBSCRIPTION_CHECKS,
  WEBHOOK_CHECKS,
  createPageRegistry,
} from "../../index.js";
import {
  CheckRegistry,
  POINTS,
  SIZES,
  defineCheck,
  type Check,
  type Finding,
  type Severity,
  type Size,
} from "../../model.js";
import { RESULT_SCHEMA_VERSION, buildResult, type Result } from "../../result.js";
import { BRIEF_SCHEMA_VERSION, briefSchema, parseBrief } from "../brief-schema.js";
import {
  buildBrief,
  costRange,
  escapeMarkdown,
  formatCurrency,
  hoursRange,
  renderBriefMarkdown,
  type BriefOptions,
} from "../brief.js";

/** An invented check: only its size, severity and wording matter to the work order. */
function sized(id: string, size: Size, severity: Severity = "medium"): Check<unknown> {
  return defineCheck<unknown>({
    id,
    area: "Visitors",
    severity,
    title: `Title of ${id}`,
    what: `What is wrong with ${id}.`,
    why: `Why ${id} matters.`,
    fix: `How to fix ${id}.`,
    tech: `Tech line of ${id}`,
    size,
    done: `${id} no longer shows up when Gaugeline runs again.`,
    estimateChanges: `How many places ${id} is hardcoded in.`,
    run: () => [],
  });
}

function registry(...checks: Check<unknown>[]): CheckRegistry {
  const r = new CheckRegistry();
  for (const c of checks) r.register(c);
  return r;
}

function finding(
  checkId: string,
  severity: Severity = "medium",
  evidence = `${checkId} evidence`,
  url = "https://cornerbar.test/",
): Finding {
  return { checkId, severity, title: `Title of ${checkId}`, evidence, url };
}

function resultOf(findings: Finding[], extra: Partial<Parameters<typeof buildResult>[0]> = {}) {
  return buildResult({
    url: "https://cornerbar.test/",
    startedAt: new Date("2026-11-10T09:00:00.000Z"),
    findings,
    passed: [],
    failed: [],
    ...extra,
  });
}

/** Two S, one M and one L: 1 + 1 + 3 + 8 = 13 points. */
const KNOWN = registry(
  sized("small-a", "S", "high"),
  sized("small-b", "S", "low"),
  sized("medium-a", "M", "medium"),
  sized("large-a", "L", "high"),
);
const KNOWN_FINDINGS = [
  finding("small-b", "low"),
  finding("large-a", "high"),
  finding("medium-a", "medium"),
  finding("small-a", "high"),
];

/** The work order as the CLI makes it: build the data, then render it. */
const briefMarkdown = (result: Result, reg: CheckRegistry, opts: BriefOptions = {}): string =>
  renderBriefMarkdown(buildBrief(result, reg, opts));

/** Every line of the work order, as lines (never split on a bare newline literal in an assertion). */
const lines = (text: string): string[] => text.split(/\r?\n/);

describe("brief: unit (points, hours and money)", () => {
  it("POINTS is 1, 3 and 8, and SIZES lists the three sizes", () => {
    expect(POINTS).toEqual({ S: 1, M: 3, L: 8 });
    expect([...SIZES]).toEqual(["S", "M", "L"]);
  });

  it("totals the points of a known set of findings, read through the registry: 2 S, 1 M, 1 L is 13", () => {
    const text = briefMarkdown(resultOf(KNOWN_FINDINGS), KNOWN);
    expect(text).toContain("4 items are worth paying to fix, 13 points in all");
  });

  it("gives the hours range and the money range for 1.5 hours per point at 110 an hour (11 points)", () => {
    // 11 points at 1.5 hours is 16.5; the range runs from 80% to 130% of it: 13.2 to 21.45 hours.
    expect(hoursRange(11, 1.5)).toEqual({ low: 13, high: 21 });
    expect(costRange(11, 1.5, 11000, "usd")).toEqual({
      lowMinor: 145200,
      highMinor: 236000,
      currency: "usd",
    });
    expect(formatCurrency(145200, "usd")).toBe("$1,452");
    expect(formatCurrency(236000, "usd")).toBe("$2,360");
  });

  it("prints the spec's sentence for the known 13 points at 1.5 hours per point and 110 an hour", () => {
    expect(hoursRange(13, 1.5)).toEqual({ low: 16, high: 25 });
    expect(costRange(13, 1.5, 11000, "usd")).toMatchObject({ lowMinor: 171600, highMinor: 278900 });
    const text = briefMarkdown(resultOf(KNOWN_FINDINGS), KNOWN, {
      hoursPerPoint: 1.5,
      rateMinor: 11000,
    });
    expect(text).toContain(
      "At 1.5 hours per point, that's roughly 16\u201325 hours (about $1,716\u2013$2,789 at $110/hour).",
    );
  });

  it("works in whole numbers: no float drift in the hours or the money", () => {
    // 0.1 + 0.2 style drift would show here if hours were multiplied as floats.
    expect(hoursRange(3, 0.1)).toEqual({ low: 1, high: 2 });
    expect(costRange(7, 1.1, 9999, "usd").lowMinor % 100).toBe(0);
    // Exactly half a unit rounds up: 21.45 hours at $110 is $2,359.50, shown as $2,360.
    expect(costRange(11, 1.5, 11000).highMinor).toBe(236000);
  });

  it("never prints a single number: a range that rounds to one hour still has two ends", () => {
    const { low, high } = hoursRange(1, 1);
    expect(high).toBeGreaterThan(low);
  });

  it("formats money in whole units, with the currency's own symbol", () => {
    expect(formatCurrency(11000, "usd")).toBe("$110");
    expect(formatCurrency(11000)).toBe("$110");
    expect(formatCurrency(11050, "usd")).toBe("$110.50");
    expect(formatCurrency(110, "jpy")).toBe("\u00A5110");
    expect(formatCurrency(11000, "eur")).toBe("\u20AC110");
    expect(formatCurrency(123456700, "usd")).toBe("$1,234,567");
  });

  it("refuses an hours-per-point or a rate that is not a positive whole number it can use", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => hoursRange(5, bad), String(bad)).toThrow(RangeError);
    for (const bad of [-100, 1.5, Number.NaN])
      expect(() => costRange(5, 1, bad), String(bad)).toThrow(RangeError);
  });
});

describe("brief: defineCheck and sizes", () => {
  const base = {
    id: "needs-size",
    area: "Visitors",
    severity: "low",
    title: "t",
    what: "w",
    why: "y",
    fix: "f",
    tech: "x",
    size: "S",
    done: "It is fixed.",
    estimateChanges: "How many places.",
    run: () => [],
  } as const;

  it("defineCheck throws when the size is missing, naming the check", () => {
    const { size: _size, ...without } = base;
    void _size;
    expect(() => defineCheck(without as unknown as Check<unknown>)).toThrow(
      /Check "needs-size" has no size/,
    );
  });

  it("defineCheck throws on a size that is not S, M or L, and on an empty done or estimateChanges", () => {
    expect(() => defineCheck({ ...base, size: "XL" } as unknown as Check<unknown>)).toThrow(/size/);
    expect(() => defineCheck({ ...base, done: " " } as unknown as Check<unknown>)).toThrow(/done/);
    expect(() =>
      defineCheck({ ...base, estimateChanges: "" } as unknown as Check<unknown>),
    ).toThrow(/estimateChanges/);
    expect(() => defineCheck(base as unknown as Check<unknown>)).not.toThrow();
  });
});

describe("brief: snapshot", () => {
  const registryForSnapshots = registry(
    sized("viewport", "S", "medium"),
    sized("images-alt-missing", "S", "low"),
    sized("page-lost-content", "M", "high"),
    sized("gated-download-open", "L", "high"),
    sized("og-image-missing", "S", "low"),
  );
  const mixed = resultOf(
    [
      finding(
        "og-image-missing",
        "low",
        "no og:image on https://cornerbar.test/",
        "https://cornerbar.test/menu",
      ),
      finding(
        "gated-download-open",
        "high",
        "GET /downloads/wine-list.pdf gave 200 with no session",
        "https://cornerbar.test/downloads/wine-list.pdf",
      ),
      finding(
        "images-alt-missing",
        "low",
        "2 images have no alt: /img/bar.jpg, /img/taps.jpg",
        "https://cornerbar.test/",
      ),
      finding(
        "images-alt-missing",
        "low",
        "1 image has no alt: /img/patio.jpg",
        "https://cornerbar.test/events",
      ),
      finding("viewport", "medium", "no viewport meta tag", "https://cornerbar.test/"),
      finding(
        "page-lost-content",
        "high",
        "the opening hours block is gone",
        "https://cornerbar.test/visit",
      ),
      finding(
        "custom-removed-check",
        "medium",
        "a check this version does not have",
        "https://cornerbar.test/",
      ),
    ],
    {
      couldNotCheck: [
        { id: "listing-hours-mismatch", reason: "needs a listing", url: "https://cornerbar.test/" },
      ],
    },
  );

  it("the clean fixture", () => {
    const text = briefMarkdown(resultOf([], { passed: ["viewport"] }), registryForSnapshots, {
      business: "The Corner Bar",
    });
    expect(text).toMatchSnapshot();
  });

  it("the mixed fixture, with hours and a rate", () => {
    const text = briefMarkdown(mixed, registryForSnapshots, {
      business: "The Corner Bar",
      hoursPerPoint: 1.5,
      rateMinor: 11000,
    });
    expect(text).toMatchSnapshot();
  });

  it("the mixed fixture with points only", () => {
    const text = briefMarkdown(mixed, registryForSnapshots);
    expect(text).toMatchSnapshot();
  });
});

describe("brief: order and grouping", () => {
  it("orders items by severity, then by size with the smallest first, then as the findings came", () => {
    const r = registry(
      sized("low-s", "S", "low"),
      sized("high-l", "L", "high"),
      sized("high-s", "S", "high"),
      sized("high-m", "M", "high"),
      sized("med-m", "M", "medium"),
      sized("med-s", "S", "medium"),
      sized("med-s-later", "S", "medium"),
    );
    const found = [
      finding("low-s", "low"),
      finding("med-s-later", "medium"),
      finding("high-l", "high"),
      finding("med-m", "medium"),
      finding("high-m", "high"),
      finding("med-s", "medium"),
      finding("high-s", "high"),
    ];
    const headings = lines(briefMarkdown(resultOf(found), r))
      .filter((l) => /^## \d+\. /.test(l))
      .map((l) => l.replace(/^## \d+\. /, ""));
    expect(headings).toEqual([
      "Title of high-s",
      "Title of high-m",
      "Title of high-l",
      "Title of med-s-later",
      "Title of med-s",
      "Title of med-m",
      "Title of low-s",
    ]);
  });

  it("never guesses a size from the severity: a high finding of a Small check is 1 point", () => {
    const r = registry(sized("high-but-small", "S", "high"));
    expect(briefMarkdown(resultOf([finding("high-but-small", "high")]), r)).toContain(
      "1 item is worth paying to fix, 1 point in all",
    );
  });

  it("several findings from one check are one item with several evidence lines, sized once", () => {
    const r = registry(sized("images-alt-missing", "S", "low"));
    const text = briefMarkdown(
      resultOf([
        finding("images-alt-missing", "low", "3 images have no alt", "https://cornerbar.test/"),
        finding("images-alt-missing", "low", "1 image has no alt", "https://cornerbar.test/menu"),
        finding(
          "images-alt-missing",
          "low",
          "5 images have no alt",
          "https://cornerbar.test/events",
        ),
      ]),
      r,
    );
    expect(text).toContain("1 item is worth paying to fix, 1 point in all");
    expect(lines(text).filter((l) => l.startsWith("- ") && l.includes("no alt"))).toEqual([
      "- 3 images have no alt (https://cornerbar.test/)",
      "- 1 image has no alt (https://cornerbar.test/menu)",
      "- 5 images have no alt (https://cornerbar.test/events)",
    ]);
    expect(lines(text).filter((l) => /^## \d+\. /.test(l))).toHaveLength(1);
  });

  it("an identical evidence line from the same page is listed once", () => {
    const r = registry(sized("viewport", "S"));
    const text = briefMarkdown(
      resultOf([
        finding("viewport", "medium", "no viewport"),
        finding("viewport", "medium", "no viewport"),
      ]),
      r,
    );
    expect(lines(text).filter((l) => l.includes("no viewport"))).toHaveLength(1);
  });

  it("an item takes the highest severity among its findings", () => {
    const r = registry(sized("mixed-levels", "S", "low"));
    const text = briefMarkdown(
      resultOf([finding("mixed-levels", "low"), finding("mixed-levels", "high")]),
      r,
    );
    expect(text).toContain("Fix this first");
  });

  it("is deterministic and leaves its input alone", () => {
    const r = resultOf(KNOWN_FINDINGS);
    const frozen = Object.freeze({
      ...r,
      findings: Object.freeze(r.findings.map((f) => Object.freeze({ ...f }))) as Result["findings"],
    }) as Result;
    const a = briefMarkdown(frozen, KNOWN, { business: "The Corner Bar", hoursPerPoint: 2 });
    const b = briefMarkdown(frozen, KNOWN, { business: "The Corner Bar", hoursPerPoint: 2 });
    expect(a).toBe(b);
    expect(frozen.findings.map((f) => f.checkId)).toEqual(KNOWN_FINDINGS.map((f) => f.checkId));
  });
});

describe("brief: edge cases", () => {
  it("with no findings, says nothing needs paying for, and has no table, hours or money", () => {
    const text = briefMarkdown(resultOf([]), KNOWN, {
      hoursPerPoint: 1.5,
      rateMinor: 11000,
    });
    expect(text).toMatch(/Nothing needs paying for/);
    expect(text).not.toMatch(/hours per point/);
    expect(text).not.toMatch(/\|/);
    expect(lines(text).filter((l) => /^## \d+\. /.test(l))).toHaveLength(0);
  });

  it("a rate without hours-per-point prints points only", () => {
    const text = briefMarkdown(resultOf(KNOWN_FINDINGS), KNOWN, { rateMinor: 11000 });
    expect(text).toContain("13 points in all");
    expect(text).not.toMatch(/hours/);
    expect(text).not.toMatch(/\$/);
  });

  it("hours-per-point without a rate prints hours and no money", () => {
    const text = briefMarkdown(resultOf(KNOWN_FINDINGS), KNOWN, { hoursPerPoint: 1.5 });
    expect(text).toContain("At 1.5 hours per point, that's roughly 16\u201325 hours.");
    expect(text).not.toMatch(/\$/);
  });

  it("escapes Markdown characters in a business name", () => {
    const text = briefMarkdown(resultOf([]), KNOWN, {
      business: "Joe's *Bar* [promo](http://x.test) <b>& `code`",
    });
    const heading = lines(text)[0] ?? "";
    expect(heading).toBe(
      "# Work order: Joe's \\*Bar\\* \\[promo\\]\\(http://x.test\\) \\<b\\>\\& \\`code\\`",
    );
    expect(escapeMarkdown("a_b")).toBe("a\\_b");
  });

  it("a business name cannot start another heading or a list with a line break", () => {
    const text = briefMarkdown(resultOf([]), KNOWN, { business: "Bar\n# Injected\n- item" });
    expect(lines(text).filter((l) => l.startsWith("# "))).toHaveLength(1);
    expect(lines(text).some((l) => l.startsWith("- item"))).toBe(false);
  });

  it("lists a finding whose check is not in the registry as unsized, with a note, and leaves it out of the total", () => {
    const text = briefMarkdown(
      resultOf([finding("removed-custom-check", "high", "something it found"), ...KNOWN_FINDINGS]),
      KNOWN,
    );
    expect(text).toContain("4 items are worth paying to fix, 13 points in all");
    expect(text).toMatch(/## Not sized/);
    expect(text).toContain("removed-custom-check");
    expect(text).toMatch(/no size and are not in the total/);
    // Unsized items never appear as numbered items.
    expect(lines(text).filter((l) => /^## \d+\. /.test(l))).toHaveLength(4);
  });

  it("a result with only unsized findings has 0 points and says so", () => {
    const text = briefMarkdown(resultOf([finding("gone", "high")]), KNOWN);
    expect(text).toMatch(/Nothing needs paying for/);
    expect(text).toMatch(/## Not sized/);
  });

  it("evidence from a page is escaped: markup, links, line breaks and invisible characters", () => {
    const r = registry(sized("viewport", "S"));
    const hostile = `<script>alert(1)</script> [x](https://evil.test) \`tick\`\n# Heading\n- list\u200B\u202E`;
    const text = briefMarkdown(resultOf([finding("viewport", "medium", hostile)]), r);
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("[x](https://evil.test)");
    expect(text).not.toContain("\u200B");
    expect(text).not.toContain("\u202E");
    expect(text).toContain("\\u{200B}");
    expect(lines(text).filter((l) => l.startsWith("# "))).toHaveLength(1);
    expect(lines(text).some((l) => l.startsWith("- list"))).toBe(false);
  });

  it("adds the address to a line of evidence only when the evidence does not name it already", () => {
    const r = registry(sized("viewport", "S"));
    const text = briefMarkdown(
      resultOf([
        finding(
          "viewport",
          "medium",
          "no viewport on https://cornerbar.test/menu",
          "https://cornerbar.test/menu",
        ),
        finding("viewport", "medium", "no viewport", "https://cornerbar.test/events"),
      ]),
      r,
    );
    expect(lines(text).filter((l) => l.startsWith("- "))).toEqual([
      "- no viewport on https://cornerbar.test/menu",
      "- no viewport (https://cornerbar.test/events)",
    ]);
  });

  it("evidence that starts like a list item or a numbered list cannot nest one", () => {
    const r = registry(sized("viewport", "S"));
    const text = briefMarkdown(
      resultOf([
        finding("viewport", "medium", "- a dash", ""),
        finding("viewport", "medium", "1. a number", ""),
        finding("viewport", "medium", "2) another", ""),
      ]),
      r,
    );
    expect(lines(text).filter((l) => l.startsWith("- "))).toEqual([
      "- \\- a dash",
      "- 1\\. a number",
      "- 2\\) another",
    ]);
  });

  it("evidence is cut at 300 characters", () => {
    const r = registry(sized("viewport", "S"));
    const text = briefMarkdown(resultOf([finding("viewport", "medium", "x".repeat(900))]), r);
    expect(text).not.toContain("x".repeat(301));
  });

  it("drops the query string of an address, which can carry a token", () => {
    const r = registry(sized("viewport", "S"));
    const text = briefMarkdown(
      resultOf([
        finding("viewport", "medium", "no viewport", "https://cornerbar.test/menu?token=abc123"),
      ]),
      r,
    );
    expect(text).not.toContain("abc123");
    expect(text).toContain("https://cornerbar.test/menu");
  });

  it("says when some checks could not read the site, so a short work order is not read as a clean bill", () => {
    const text = briefMarkdown(
      resultOf([finding("viewport", "medium")], {
        couldNotCheck: [
          { id: "a", reason: "r", url: "https://cornerbar.test/" },
          { id: "b", reason: "r", url: "https://cornerbar.test/" },
        ],
      }),
      registry(sized("viewport", "S")),
    );
    expect(text).toMatch(/2 checks could not read parts of the site/);
  });

  it("names the host when there is no business name", () => {
    expect(lines(briefMarkdown(resultOf([]), KNOWN))[0]).toBe("# Work order: cornerbar.test");
  });

  it("every item shows what is wrong, why it matters, what done looks like, the evidence and what changes the estimate", () => {
    const text = briefMarkdown(resultOf([finding("small-a", "high", "the evidence")]), KNOWN);
    for (const label of [
      "**What is wrong:** What is wrong with small-a.",
      "**Why it matters:** Why small-a matters.",
      "**What done looks like:** small-a no longer shows up when Gaugeline runs again.",
      "**What changes the estimate:** How many places small-a is hardcoded in.",
      "**Evidence:**",
    ])
      expect(text, label).toContain(label);
  });
});

describe("brief: every built-in check has a size", () => {
  const all = (() => {
    const r = createPageRegistry();
    for (const set of [
      PLAN_CHECKS,
      PRINTED_CHECKS,
      CAMPAIGN_CHECKS,
      AD_LANDING_CHECKS,
      DUPLICATE_CHECKS,
      PRESENCE_CHECKS,
      PRICE_CHECKS,
      SUBSCRIPTION_CHECKS,
      QUERY_CHECKS,
      QUERY_DUPE_CHECKS,
      QUERY_GENERATED_CHECKS,
      QUERY_UNUSED_CHECKS,
      MUTATION_CHECKS,
      GRAPHQL_CHECKS,
      RECEIPT_CHECKS,
      ROUTE_CHECKS,
      WEBHOOK_CHECKS,
      CUTOVER_ONLY_CHECKS,
    ])
      for (const c of set as readonly Check<never>[]) r.register(c);
    return r;
  })();

  it("walks the registry and fails on the first check without a size, a done sentence or an estimate sentence", () => {
    expect(all.size).toBeGreaterThan(200);
    for (const c of all.all()) {
      expect(SIZES, `${c.id} has no size`).toContain(c.size);
      expect(typeof c.done === "string" && c.done.trim() !== "", `${c.id} has no done`).toBe(true);
      expect(
        typeof c.estimateChanges === "string" && c.estimateChanges.trim() !== "",
        `${c.id} has no estimateChanges`,
      ).toBe(true);
    }
  });

  it("the sentences are plain: one line, ending with a full stop, no markup", () => {
    for (const c of all.all()) {
      for (const field of ["done", "estimateChanges"] as const) {
        const text = c[field] as string;
        expect(text, `${c.id} ${field}`).toMatch(/^\S.*[.)]$/);
        expect(text, `${c.id} ${field}`).not.toMatch(/[\r\n<>`]/);
      }
    }
  });

  it("the checks reference carries each check's size, done and estimateChanges", () => {
    for (const e of catalogue(all)) {
      const c = all.get(e.id);
      expect(e.size).toBe(c?.size);
      expect(e.done).toBe(c?.done);
      expect(e.estimateChanges).toBe(c?.estimateChanges);
    }
  });

  it("a built-in set has a mix of sizes, so the work order does not size everything alike", () => {
    const counts = new Map<Size, number>();
    for (const c of all.all()) counts.set(c.size, (counts.get(c.size) ?? 0) + 1);
    for (const size of SIZES) expect(counts.get(size) ?? 0, size).toBeGreaterThan(0);
  });

  it("every built-in finding is looked up, never sized from its severity", () => {
    const high = all.all().filter((c) => c.severity === "high");
    const sizes = new Set(high.map((c) => c.size));
    expect(sizes.size).toBeGreaterThan(1);
  });
});

describe("brief: it only formats", () => {
  const read = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
  const importsOf = (source: string): string[] =>
    [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1] ?? "").sort();

  it("brief.ts imports only the pure modules it needs: no file system, network, fetcher or CLI code", () => {
    expect(importsOf(read("brief.ts"))).toEqual([
      "../checks/hidden-text/escape.js",
      "../model.js",
      "../products/money.js",
      "../result.js",
      "./brief-schema.js",
    ]);
    expect(importsOf(read("brief-schema.ts"))).toEqual(["../model.js", "zod"]);
  });

  it("neither file reaches for fs, net, http, the fetcher, the CLI, the clock, the process or a request", () => {
    for (const name of ["brief.ts", "brief-schema.ts"]) {
      const source = read(name);
      for (const from of importsOf(source)) {
        expect(from, `${name} imports ${from}`).not.toMatch(
          /^(node:|fs$|net$|http|https$|child_process|dns|os$|path$)|fetch|cli|@gaugeline\/(?!core)/,
        );
      }
      expect(source, name).not.toMatch(
        /process\.|Date\.now|new Date\(|fetch\(|Math\.random|require\(|import\(/,
      );
    }
  });
});

describe("buildBrief and renderBriefMarkdown (G28a)", () => {
  const priced: BriefOptions = { business: "The Corner Bar", hoursPerPoint: 1.5, rateMinor: 11000 };

  it("builds the data for a known result: item count, points, the hours range and the cost range", () => {
    const brief = buildBrief(resultOf(KNOWN_FINDINGS), KNOWN, priced);
    expect(brief.schemaVersion).toBe(BRIEF_SCHEMA_VERSION);
    expect(brief.business).toBe("The Corner Bar");
    expect(brief.items).toHaveLength(4);
    expect(brief.points).toBe(13);
    expect(brief.hours).toEqual({ low: 16, high: 25 });
    expect(brief.cost).toEqual({ lowMinor: 171600, highMinor: 278900, currency: "usd" });
    expect(brief.items.map((i) => [i.checkId, i.size, i.points])).toEqual([
      ["small-a", "S", 1],
      ["large-a", "L", 8],
      ["medium-a", "M", 3],
      ["small-b", "S", 1],
    ]);
  });

  it("an item has the check's own words and its evidence, as plain text", () => {
    const [item] = buildBrief(resultOf([finding("small-a", "high", "no viewport")]), KNOWN).items;
    expect(item).toMatchObject({
      checkId: "small-a",
      title: "Title of small-a",
      severity: "high",
      wrong: "What is wrong with small-a.",
      why: "Why small-a matters.",
      done: "small-a no longer shows up when Gaugeline runs again.",
      estimateChanges: "How many places small-a is hardcoded in.",
      evidence: ["no viewport (https://cornerbar.test/)"],
    });
  });

  it("three findings from one check are one item with three evidence lines", () => {
    const r = registry(sized("images-alt-missing", "S", "low"));
    const brief = buildBrief(
      resultOf([
        finding("images-alt-missing", "low", "3 images have no alt", "https://cornerbar.test/"),
        finding("images-alt-missing", "low", "1 image has no alt", "https://cornerbar.test/menu"),
        finding("images-alt-missing", "low", "5 images have no alt", "https://cornerbar.test/x"),
      ]),
      r,
    );
    expect(brief.items).toHaveLength(1);
    expect(brief.items[0]?.evidence).toEqual([
      "3 images have no alt (https://cornerbar.test/)",
      "1 image has no alt (https://cornerbar.test/menu)",
      "5 images have no alt (https://cornerbar.test/x)",
    ]);
    expect(brief.points).toBe(1);
  });

  it("renderBriefMarkdown(buildBrief(x)) is the text the command wrote in G28 (the snapshots above, made by that version)", () => {
    const reg = registry(sized("small-a", "S", "high"), sized("large-a", "L", "high"));
    const text = renderBriefMarkdown(
      buildBrief(resultOf([finding("large-a", "high"), finding("small-a", "high")]), reg, priced),
    );
    expect(lines(text).slice(0, 3)).toEqual([
      "# Work order: The Corner Bar",
      "",
      "Checked https://cornerbar.test/ at 2026-11-10T09:00:00.000Z.",
    ]);
    expect(text).toMatch(/\n$/);
  });

  it("calling it twice gives deeply equal output and leaves a frozen input alone", () => {
    const deepFreeze = <T>(v: T): T => {
      if (v !== null && typeof v === "object") {
        for (const x of Object.values(v)) deepFreeze(x);
        Object.freeze(v);
      }
      return v;
    };
    const frozen = deepFreeze(structuredClone(resultOf(KNOWN_FINDINGS)));
    const options = deepFreeze({ ...priced });
    const a = buildBrief(frozen, KNOWN, options);
    const b = buildBrief(frozen, KNOWN, options);
    expect(a).toEqual(b);
    expect(renderBriefMarkdown(a)).toBe(renderBriefMarkdown(b));
    // The output does not share objects with the input, so editing it cannot edit the result.
    expect(a.items[0]?.evidence).not.toBe(frozen.findings);
  });

  it("the data is plain JSON that its own schema accepts, and survives a round trip into the same text", () => {
    const brief = buildBrief(resultOf(KNOWN_FINDINGS), KNOWN, priced);
    const again = parseBrief(JSON.parse(JSON.stringify(brief)));
    expect(again).toEqual(brief);
    expect(renderBriefMarkdown(again)).toBe(renderBriefMarkdown(brief));
    expect(briefSchema.safeParse({ ...brief, extra: 1 }).success).toBe(false);
  });

  it("a result with no findings has no items and 0 points, and the text is the short note", () => {
    const brief = buildBrief(resultOf([]), KNOWN, { hoursPerPoint: 1.5, rateMinor: 11000 });
    expect(brief.items).toEqual([]);
    expect(brief.points).toBe(0);
    expect(brief.hours).toBeUndefined();
    expect(brief.cost).toBeUndefined();
    const text = renderBriefMarkdown(brief);
    expect(text).toContain(
      "Nothing needs paying for. Gaugeline found nothing to fix on this site.",
    );
    expect(text).not.toMatch(/\|/);
  });

  it("hoursPerPoint without a rate gives hours and no cost; a rate without hoursPerPoint gives neither", () => {
    const hours = buildBrief(resultOf(KNOWN_FINDINGS), KNOWN, { hoursPerPoint: 1.5 });
    expect(hours.hours).toEqual({ low: 16, high: 25 });
    expect(hours.cost).toBeUndefined();
    const rate = buildBrief(resultOf(KNOWN_FINDINGS), KNOWN, { rateMinor: 11000 });
    expect(rate.hours).toBeUndefined();
    expect(rate.cost).toBeUndefined();
    expect(rate.points).toBe(13);
  });

  it("uses the currency it is given for the cost and the text", () => {
    const brief = buildBrief(resultOf(KNOWN_FINDINGS), KNOWN, {
      hoursPerPoint: 1.5,
      rateMinor: 9000,
      currency: "eur",
    });
    expect(brief.cost?.currency).toBe("eur");
    expect(renderBriefMarkdown(brief)).toContain("/hour).");
    expect(renderBriefMarkdown(brief)).toMatch(/\u20ac/);
  });

  it("refuses a result from another schema, naming both versions", () => {
    const older = { ...resultOf(KNOWN_FINDINGS), schema: 1 } as unknown as Result;
    expect(() => buildBrief(older, KNOWN)).toThrow(
      `This result is schema 1; the work order reads schema ${RESULT_SCHEMA_VERSION}.`,
    );
    const newer = { ...resultOf(KNOWN_FINDINGS), schema: 3 } as unknown as Result;
    expect(() => buildBrief(newer, KNOWN)).toThrow(/schema 3.*schema 2/);
  });

  it("refuses an hours-per-point or a rate it cannot use, as before", () => {
    expect(() => buildBrief(resultOf(KNOWN_FINDINGS), KNOWN, { hoursPerPoint: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      buildBrief(resultOf(KNOWN_FINDINGS), KNOWN, { hoursPerPoint: 1, rateMinor: 1.5 }),
    ).toThrow(RangeError);
  });

  it("stores a business name unescaped and the renderer escapes it", () => {
    const business = "Joe's *Bar* [promo](http://x.test) <b>& `code`";
    const brief = buildBrief(resultOf([]), KNOWN, { business });
    expect(brief.business).toBe(business);
    expect(lines(renderBriefMarkdown(brief))[0]).toBe(
      "# Work order: Joe's \\*Bar\\* \\[promo\\]\\(http://x.test\\) \\<b\\>\\& \\`code\\`",
    );
  });

  it("a blank business name is no business name: the heading names the host", () => {
    const brief = buildBrief(resultOf([]), KNOWN, { business: "  \n " });
    expect(brief.business).toBeUndefined();
    expect(lines(renderBriefMarkdown(brief))[0]).toBe("# Work order: cornerbar.test");
  });

  it("keeps page text as plain text with invisible characters shown as escapes, and escapes it only when rendering", () => {
    const r = registry(sized("viewport", "S"));
    const brief = buildBrief(
      resultOf([finding("viewport", "medium", "a *b*\u200bc [d](e)", "https://cornerbar.test/")]),
      r,
    );
    expect(brief.items[0]?.evidence).toEqual(["a *b*\\u{200B}c [d](e) (https://cornerbar.test/)"]);
    const md = renderBriefMarkdown(brief);
    expect(lines(md)).toContain("- a \\*b\\*\\u{200B}c \\[d\\]\\(e\\) (https://cornerbar.test/)");
  });

  it("renders the evidence it is given: an edited line shows, even where the stored parts no longer match", () => {
    const r = registry(sized("viewport", "S"));
    const brief = buildBrief(resultOf([finding("viewport", "medium", "no viewport")]), r);
    const item = brief.items[0];
    if (item === undefined) throw new Error("no item");
    const edited = { ...brief, items: [{ ...item, evidence: ["checked by hand on the phone"] }] };
    const md = renderBriefMarkdown(edited);
    expect(lines(md)).toContain("- checked by hand on the phone");
    expect(md).not.toContain("no viewport");
  });

  it("a finding from a check that is not in the registry is listed as not sized, with no points", () => {
    const brief = buildBrief(
      resultOf([finding("removed-check", "high", "found something"), ...KNOWN_FINDINGS]),
      KNOWN,
    );
    expect(brief.points).toBe(13);
    expect(brief.notSized).toEqual([
      {
        checkId: "removed-check",
        title: "Title of removed-check",
        evidence: ["found something (https://cornerbar.test/)"],
        evidenceParts: [{ what: "found something", where: "https://cornerbar.test/" }],
      },
    ]);
    expect(renderBriefMarkdown(brief)).toContain("## Not sized");
  });

  it("counts the checks that could not read the site, once each", () => {
    const brief = buildBrief(
      resultOf(KNOWN_FINDINGS, {
        couldNotCheck: [
          { id: "a", reason: "x", url: "https://cornerbar.test/" },
          { id: "a", reason: "y", url: "https://cornerbar.test/menu" },
          { id: "b", reason: "x", url: "https://cornerbar.test/" },
        ],
      }),
      KNOWN,
    );
    expect(brief.couldNotCheck).toBe(2);
  });

  it("keeps the query string of the checked address out of the data", () => {
    const brief = buildBrief(
      buildResult({
        url: "https://cornerbar.test/menu?token=abc123#top",
        startedAt: new Date("2026-11-10T09:00:00.000Z"),
        findings: [],
        passed: [],
        failed: [],
      }),
      KNOWN,
    );
    expect(JSON.stringify(brief)).not.toContain("abc123");
  });
});

describe("brief: a scratch project that imports the formatter from the package's public entry", () => {
  it("type-checks, and the program holds no CLI code", async () => {
    const { importTypeScript } = await import("../../query/source.js");
    const ts = await importTypeScript();
    const here = fileURLToPath(new URL("../../index.ts", import.meta.url));
    const temp = mkdtempSync(join(tmpdir(), "gaugeline-brief-scratch-"));
    try {
      mkdirSync(join(temp, "src"));
      writeFileSync(
        join(temp, "src", "use.ts"),
        [
          'import { BRIEF_SCHEMA, buildBrief, renderBriefMarkdown, createPageRegistry } from "@gaugeline/core";',
          'import type { Brief, BriefItem, BriefOptions, Result } from "@gaugeline/core";',
          "export function workOrder(result: Result, opts: BriefOptions): string {",
          "  const brief: Brief = buildBrief(result, createPageRegistry(), opts);",
          "  const first: BriefItem | undefined = brief.items[0];",
          "  const version: 1 = BRIEF_SCHEMA;",
          "  return `${version} ${first?.checkId ?? ''} ${renderBriefMarkdown(brief)}`;",
          "}",
          "",
        ].join("\n"),
      );
      const program = ts.createProgram([join(temp, "src", "use.ts")], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        // Node's own types come from the repository, where the package's own sources already expect them.
        types: ["node"],
        typeRoots: [fileURLToPath(new URL("../../../../../node_modules/@types", import.meta.url))],
        baseUrl: temp,
        paths: { "@gaugeline/core": [here] },
      });
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .filter((d) => d.file === undefined || !/node_modules/.test(d.file.fileName))
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(diagnostics).toEqual([]);
      const files = program.getSourceFiles().map((f) => f.fileName.replaceAll("\\", "/"));
      expect(files.some((f) => f.includes("/packages/cli/"))).toBe(false);
      expect(files.some((f) => f.endsWith("/packages/core/src/report/brief.ts"))).toBe(true);
    } finally {
      rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 120_000);
});
