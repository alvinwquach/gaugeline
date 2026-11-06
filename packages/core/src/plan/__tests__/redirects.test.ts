import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR, startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, FetchError, type Hop } from "../../fetcher.js";
import { readPlan, type PlanRow } from "../read.js";
import {
  checkRedirects,
  classify,
  legacyClaims,
  redirectConflicts,
  splitLegacy,
} from "../redirects.js";

const BASE = "https://preview.example";
const row = (line: number, path: string, legacyUrl?: string): PlanRow => ({
  line,
  url: `https://shop.example${path}`,
  path,
  raw: {},
  ...(legacyUrl !== undefined ? { legacyUrl } : {}),
});
/** A hop on the preview: [path, status, location?]. */
const hop = (path: string, status: number, location?: string, body = ""): Hop => ({
  url: new URL(path, BASE).href,
  status,
  headers: location ? { location } : { "content-type": "text/html" },
  body,
  ms: 1,
});
const NEW = row(2, "/new", "/old");

describe("the 301 map: unit", () => {
  it("classify: every outcome, from the hop list", () => {
    const cases: [string, Hop[], string[]][] = [
      ["301 to the planned page", [hop("/old", 301, "/new"), hop("/new", 200)], []],
      ["302", [hop("/old", 302, "/new"), hop("/new", 200)], ["plan-redirect-not-301"]],
      ["307", [hop("/old", 307, "/new"), hop("/new", 200)], ["plan-redirect-not-301"]],
      [
        "308 to the wrong place",
        [hop("/old", 308, "/other"), hop("/other", 200)],
        ["plan-redirect-wrong-destination", "plan-redirect-not-301"],
      ],
      ["still 200", [hop("/old", 200)], ["plan-redirect-missing"]],
      ["404", [hop("/old", 404)], ["plan-redirect-missing"]],
      [
        "two hops",
        [hop("/old", 301, "/older"), hop("/older", 301, "/new"), hop("/new", 200)],
        ["plan-redirect-chain"],
      ],
      [
        "wrong destination",
        [hop("/old", 301, "/elsewhere"), hop("/elsewhere", 200)],
        ["plan-redirect-wrong-destination"],
      ],
      [
        "query dropped",
        [hop("/old?ref=mail", 301, "/new"), hop("/new", 200)],
        ["plan-redirect-drops-query"],
      ],
      ["query kept", [hop("/old?ref=mail", 301, "/new?ref=mail"), hop("/new?ref=mail", 200)], []],
    ];
    for (const [name, hops, ids] of cases)
      expect(classify(hops, NEW, "/old", BASE).ids, name).toEqual(ids);
    expect(
      classify([hop("/old", 302, "/new"), hop("/new", 200)], NEW, "/old", BASE).evidence,
    ).toEqual({
      "plan-redirect-not-301": "/old redirects with 302, not 301",
    });
  });

  it("a Legacy URL cell with several addresses: line breaks and commas", () => {
    expect(splitLegacy("/a\n/b, /c\r\n\n https://www.x.example/d ")).toEqual([
      "/a",
      "/b",
      "/c",
      "https://www.x.example/d",
    ]);
    expect(splitLegacy(undefined)).toEqual([]);
    expect(splitLegacy("  ")).toEqual([]);
  });

  it("one old address claimed by two rows that plan different pages is a conflict; by one page twice, not", () => {
    const rows = [
      row(2, "/a", "/old"),
      row(3, "/b", "/OLD/"),
      row(4, "/c", "/x"),
      row(5, "/c", "/x"),
    ];
    expect(
      legacyClaims(rows)
        .get("/old")
        ?.rows.map((r) => r.line),
    ).toEqual([2, 3]);
    expect(
      redirectConflicts(rows, "plan.csv").map((f) => [f.checkId, f.group?.lines, f.evidence]),
    ).toEqual([["plan-redirect-conflict", [2, 3], "/old is the legacy address of 2 rows: /a, /b"]]);
  });
});

describe("the 301 map: integration (the plan-redirects fixture)", () => {
  // Line numbers are the file's: the Fiction row's two-address cell spans lines 3 and 4.
  it("five findings with the right ids and lines; the 308 is a note; a row's own address isn't requested", async () => {
    const site = await startFixture("plan-redirects");
    try {
      const plan = readPlan(readFileSync(`${SITES_DIR}plan-redirects/plan.csv`, "utf8"));
      const out = await checkRedirects(plan.rows, {
        base: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        file: "plan.csv",
      });
      expect(out.findings.map((f) => [f.checkId, f.group?.lines])).toEqual([
        ["plan-redirect-not-301", [5]],
        ["plan-redirect-wrong-destination", [7]],
        ["plan-redirect-missing", [8]],
        ["plan-redirect-chain", [6]],
        ["plan-redirect-drops-query", [10]],
      ]);
      expect(out.findings.find((f) => f.checkId === "plan-redirect-chain")?.evidence).toBe(
        "/old-events takes 2 redirects: /old-events → /old-events/ → /events (the server adds a trailing slash first, then redirects again: point the old address's own form at the destination)",
      );
      expect(out.notes).toEqual([
        "/old-kids redirects with 308 (permanent, keeps the method): accepted like a 301",
      ]);
      expect(out.checked).toBe(8);
      expect(site.hits.get("/fiction-old")).toBe(1);
      // /shop once: reached from /old-gifts, never requested as its own legacy address.
      expect(site.hits.get("/shop")).toBe(1);
      expect([...site.methods.keys()]).toEqual(["GET"]);
    } finally {
      await site.close();
    }
  });
});

describe("the 301 map: edge cases", () => {
  it("308 to the right place is accepted, with a note", () => {
    const v = classify([hop("/old", 308, "/new"), hop("/new", 200)], NEW, "/old", BASE);
    expect(v.ids).toEqual([]);
    expect(v.note).toBe(
      "/old redirects with 308 (permanent, keeps the method): accepted like a 301",
    );
  });

  it("a legacy URL that is the row's own address needs no redirect and isn't requested", async () => {
    const asked: string[] = [];
    const out = await checkRedirects([row(2, "/same/", "/same")], {
      base: BASE,
      fetcher: {
        get: async (url: string) => {
          asked.push(url);
          return [hop(url, 200)];
        },
        getSite: async () => [],
        stats: { requests: 0, maxInFlight: 0 },
      },
    });
    expect([out.findings, asked]).toEqual([[], []]);
  });

  it("the right path on the wrong host (www versus bare) is the wrong destination, and says so", () => {
    const v = classify([hop("/old", 301, "https://www.shop.example/new")], NEW, "/old", BASE);
    expect(v.ids).toEqual(["plan-redirect-wrong-destination"]);
    expect(v.evidence["plan-redirect-wrong-destination"]).toBe(
      "/old redirects to the right path on www.shop.example, the plan says shop.example: one more redirect for every visitor",
    );
    // To production's own host, the planned path: right.
    expect(classify([hop("/old", 301, "https://shop.example/new")], NEW, "/old", BASE).ids).toEqual(
      [],
    );
  });

  it("a meta refresh or JavaScript redirect with status 200 is redirect-missing, with a hint", () => {
    const meta = classify(
      [hop("/old", 200, undefined, '<meta http-equiv="refresh" content="0; url=/new">')],
      NEW,
      "/old",
      BASE,
    );
    expect(meta.evidence["plan-redirect-missing"]).toBe(
      "/old returns 200 and redirects with a meta refresh: that isn't a 301, and search engines may not pass its ranking on",
    );
    const js = classify(
      [hop("/old", 200, undefined, "<script>window.location.href='/new'</script>")],
      NEW,
      "/old",
      BASE,
    );
    expect(js.evidence["plan-redirect-missing"]).toContain("redirects with JavaScript");
  });

  it("a trailing slash the server adds first counts as a chain, and the evidence says why", () => {
    const v = classify(
      [hop("/old", 301, "/old/"), hop("/old/", 301, "/new"), hop("/new", 200)],
      NEW,
      "/old",
      BASE,
    );
    expect(v.ids).toEqual(["plan-redirect-chain"]);
    expect(v.evidence["plan-redirect-chain"]).toContain("the server adds a trailing slash first");
  });

  it("a trail that leaves the preview (to production) is read up to where it leaves", async () => {
    const out = await checkRedirects([row(2, "/new", "/old")], {
      base: BASE,
      fetcher: {
        get: async (url: string) => {
          throw new FetchError("network", "shop.example could not be reached.", url, [
            hop("/old", 302, "https://shop.example/new"),
          ]);
        },
        getSite: async () => [],
        stats: { requests: 0, maxInFlight: 0 },
      },
    });
    expect(out.findings.map((f) => f.checkId)).toEqual(["plan-redirect-not-301"]);
  });
});
