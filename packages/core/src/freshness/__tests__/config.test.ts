import { describe, expect, it } from "vitest";
import {
  MAX_SPOT_CHECKS,
  exactPages,
  freshnessConfigSchema,
  freshnessReferenceProblems,
  freshnessSources,
  matchesPage,
  ruleName,
  usesSanity,
  type FreshnessConfig,
} from "../config.js";

const parse = (value: unknown): FreshnessConfig => freshnessConfigSchema.parse(value);
const problems = (value: unknown): string[] => {
  const got = freshnessConfigSchema.safeParse(value);
  return got.success ? [] : got.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

/** The example in the spec, with the optional source comparison. */
const SPEC = {
  freshness: [
    {
      page: "/players/*",
      stamp: { selector: "[data-updated]", jsonld: "dateModified" },
      maxAge: "6h",
      activeWhen: { months: [10, 11, 12, 1, 2, 3, 4, 5, 6] },
      source: "db:latestSync",
      maxLag: "1h",
    },
  ],
};

describe("gaugeline.freshness.json: unit", () => {
  it("accepts the shape the spec gives", () => {
    const config = parse(SPEC);
    expect(config.freshness).toHaveLength(1);
    expect(ruleName(config.freshness[0]!)).toBe("/players/*");
  });

  it("accepts a time zone, ids, spot checks and a forecast rule", () => {
    const config = parse({
      timeZone: "America/New_York",
      freshness: [
        {
          id: "player-pages",
          page: "/players/*",
          stamp: { selector: "time.updated", attr: "datetime" },
          maxAge: "6h",
          spot: [
            { name: "points per game", selector: ".ppg", source: "db:playerPpg", tolerance: "1%" },
          ],
        },
        {
          id: "picks",
          page: "/predictions",
          forecast: { item: ".pick", date: "time", settled: ".final" },
        },
        { page: "/standings", forecast: { jsonld: "startDate" } },
      ],
    });
    expect(config.timeZone).toBe("America/New_York");
    expect(config.freshness.map(ruleName)).toEqual(["player-pages", "picks", "/standings"]);
  });

  it("says what is missing, in plain words, with the path of the field", () => {
    expect(problems({})).toContain("freshness: Invalid input: expected array, received undefined");
    expect(problems({ freshness: [] })).toEqual([expect.stringMatching(/at least one rule/)]);
    expect(problems({ freshness: [{ page: "/x" }] })).toEqual([
      expect.stringMatching(/freshness\.0: .*stamp.*spot.*forecast/),
    ]);
    expect(problems({ freshness: [{ page: "/x", stamp: { selector: "time" } }] })).toEqual([
      expect.stringMatching(/freshness\.0\.maxAge: .*maxAge/),
    ]);
    expect(
      problems({ freshness: [{ page: "/x", maxAge: "6h", forecast: { jsonld: "startDate" } }] }),
    ).toEqual([expect.stringMatching(/freshness\.0\.stamp: .*stamp/)]);
    expect(problems({ freshness: [{ page: "/x", stamp: {}, maxAge: "6h" }] })).toEqual([
      expect.stringMatching(/freshness\.0\.stamp: .*selector or jsonld/),
    ]);
  });

  it("refuses durations it cannot read, naming the forms it can", () => {
    const bad = problems({
      freshness: [{ page: "/x", stamp: { selector: "time" }, maxAge: "soon" }],
    });
    expect(bad).toEqual([expect.stringMatching(/maxAge: .*"6h", "2d", "90m"/)]);
    expect(
      problems({ freshness: [{ page: "/x", stamp: { selector: "time" }, maxAge: "0h" }] }),
    ).not.toEqual([]);
    expect(
      problems({ freshness: [{ page: "/x", stamp: { selector: "time" }, maxAge: "500d" }] }),
    ).not.toEqual([]);
  });

  it("the source comparison needs both halves, and a stamp to compare", () => {
    const stamp = { selector: "time" };
    expect(
      problems({ freshness: [{ page: "/x", stamp, maxAge: "6h", source: "db:latestSync" }] }),
    ).toEqual([expect.stringMatching(/maxLag/)]);
    expect(problems({ freshness: [{ page: "/x", stamp, maxAge: "6h", maxLag: "1h" }] })).toEqual([
      expect.stringMatching(/source/),
    ]);
    expect(
      problems({
        freshness: [
          { page: "/x", forecast: { jsonld: "startDate" }, source: "db:a", maxLag: "1h" },
        ],
      }),
    ).not.toEqual([]);
    expect(
      problems({
        freshness: [{ page: "/x", stamp, maxAge: "6h", source: "mysql:a.b", maxLag: "1h" }],
      }),
    ).toEqual([expect.stringMatching(/source: .*db:latestSync/)]);
  });

  it("months are 1 to 12, once each", () => {
    const rule = (months: unknown) => ({
      freshness: [
        { page: "/x", stamp: { selector: "time" }, maxAge: "6h", activeWhen: { months } },
      ],
    });
    expect(problems(rule([0]))).not.toEqual([]);
    expect(problems(rule([13]))).not.toEqual([]);
    expect(problems(rule([]))).not.toEqual([]);
    expect(problems(rule([1, 1]))).toEqual([expect.stringMatching(/once/)]);
    expect(problems(rule(["jan"]))).not.toEqual([]);
    expect(problems(rule([12, 1]))).toEqual([]);
  });

  it("allows at most five spot checks per rule", () => {
    const spot = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ selector: `.v${i}`, source: "db:q" }));
    expect(MAX_SPOT_CHECKS).toBe(5);
    expect(problems({ freshness: [{ page: "/x", spot: spot(5) }] })).toEqual([]);
    expect(problems({ freshness: [{ page: "/x", spot: spot(6) }] })).toEqual([
      expect.stringMatching(/at most 5/),
    ]);
  });

  it("tolerance is a plain amount or a percentage", () => {
    const one = (tolerance: unknown) => ({
      freshness: [{ page: "/x", spot: [{ selector: ".v", source: "db:q", tolerance }] }],
    });
    for (const ok of [0, 0.1, 2, "0.5", "2%", "0.25%"])
      expect(problems(one(ok)), String(ok)).toEqual([]);
    for (const bad of [-1, "-2%", "lots", "%", true])
      expect(problems(one(bad)), String(bad)).not.toEqual([]);
  });

  it("a forecast rule names where the items and their dates are, one way or the other", () => {
    const f = (forecast: unknown) => ({ freshness: [{ page: "/x", forecast }] });
    expect(problems(f({ item: ".pick" }))).toEqual([]);
    expect(problems(f({ jsonld: "startDate" }))).toEqual([]);
    expect(problems(f({}))).toEqual([expect.stringMatching(/item.*jsonld/)]);
    expect(problems(f({ item: ".pick", jsonld: "startDate" }))).toEqual([
      expect.stringMatching(/not both/),
    ]);
    expect(problems(f({ jsonld: "startDate", date: "time" }))).toEqual([
      expect.stringMatching(/item/),
    ]);
    expect(problems(f({ item: ".pick", lasts: "forever" }))).not.toEqual([]);
  });

  it("refuses a selector that is not CSS, an unknown time zone and unknown keys", () => {
    expect(
      problems({ freshness: [{ page: "/x", stamp: { selector: "div[[" }, maxAge: "6h" }] }),
    ).toEqual([expect.stringMatching(/stamp\.selector: .*CSS selector/)]);
    expect(
      problems({
        timeZone: "Mars/Olympus",
        freshness: [{ page: "/x", forecast: { jsonld: "startDate" } }],
      }),
    ).toEqual([expect.stringMatching(/timeZone: .*IANA/)]);
    expect(
      problems({ freshness: [{ page: "/x", forecast: { jsonld: "startDate" }, typo: 1 }] }),
    ).not.toEqual([]);
  });

  it("pages are paths on the site, not addresses", () => {
    const rule = (page: string) => ({ freshness: [{ page, forecast: { jsonld: "startDate" } }] });
    for (const ok of ["/", "/players/*", "/players/**", "/standings"])
      expect(problems(rule(ok)), ok).toEqual([]);
    for (const bad of ["players", "https://x.example/p", "/p?x=1", "/p#a", "/a b"])
      expect(problems(rule(bad)), bad).not.toEqual([]);
  });

  it("two rules may not share a name, and a file names at most 16 exact pages", () => {
    const forecast = { jsonld: "startDate" };
    expect(
      problems({
        freshness: [
          { id: "a", page: "/x", forecast },
          { id: "a", page: "/y", forecast },
        ],
      }),
    ).toEqual([expect.stringMatching(/"a" is used by two rules/)]);
    const many = Array.from({ length: 17 }, (_, i) => ({ page: `/p${i}`, forecast }));
    expect(problems({ freshness: many })).toEqual([expect.stringMatching(/17 different pages/)]);
    // Patterns do not count: they match pages the run already has.
    const globs = Array.from({ length: 17 }, (_, i) => ({ page: `/p${i}/*`, forecast }));
    expect(problems({ freshness: globs })).toEqual([]);
  });
});

describe("matchesPage: unit", () => {
  it.each([
    ["/players/*", "/players/jane-example", true],
    ["/players/*", "/players/jane-example/", true],
    ["/players/*", "/players", false],
    ["/players/*", "/players/jane/stats", false],
    ["/players/**", "/players/jane/stats", true],
    ["/standings", "/standings", true],
    ["/standings", "/standings/", true],
    ["/standings", "/standings/east", false],
    ["/", "/", true],
    ["/", "/about", false],
    ["/teams/*/roster", "/teams/hawks/roster", true],
    ["/teams/*/roster", "/teams/hawks/schedule", false],
    ["/a.b", "/axb", false],
  ])("%s against %s is %s", (pattern, path, want) => {
    expect(matchesPage(pattern, path)).toBe(want);
  });
});

describe("what the file names: unit", () => {
  const config = parse({
    freshness: [
      {
        page: "/players/*",
        stamp: { selector: "time" },
        maxAge: "6h",
        source: "db:latestSync",
        maxLag: "1h",
        spot: [{ selector: ".ppg", source: "db:playerPpg" }],
      },
      {
        page: "/standings",
        stamp: { selector: "time" },
        maxAge: "1d",
        source: "sanity:siteSettings._updatedAt",
        maxLag: "1h",
      },
      { page: "/predictions/", forecast: { jsonld: "startDate" } },
    ],
  });

  it("lists the exact pages once, without a trailing slash", () => {
    expect(exactPages(config)).toEqual(["/standings", "/predictions"]);
  });

  it("lists each source once", () => {
    expect(freshnessSources(config)).toEqual([
      "db:latestSync",
      "db:playerPpg",
      "sanity:siteSettings._updatedAt",
    ]);
    expect(usesSanity(config)).toBe(true);
  });

  it("db: sources must name a query of the sources file", () => {
    const sources = { sources: { db: { queries: { latestSync: "select 1" } } } };
    expect(freshnessReferenceProblems(config, sources)).toEqual([
      expect.stringContaining('freshness.0.spot.0.source: "db:playerPpg"'),
    ]);
    expect(freshnessReferenceProblems(config, undefined)[0]).toContain(
      "needs a gaugeline.sources.json",
    );
    const both = {
      sources: { db: { queries: { latestSync: "select 1", playerPpg: "select 2" } } },
    };
    expect(freshnessReferenceProblems(config, both)).toEqual([]);
  });
});
