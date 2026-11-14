import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR, startFixture } from "../../../../fixtures/src/index.js";
import { ConfigError } from "../../errors.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { canonicalIsThisPage, checkBuilt } from "../built.js";
import { textKey } from "../keys.js";
import { readPlan, type PlanRow } from "../read.js";

const row = (line: number, url: string, extra: Partial<PlanRow> = {}): PlanRow => {
  const u = new URL(url);
  return {
    line,
    url,
    path: u.pathname,
    ...(u.hash ? { fragment: u.hash.slice(1) } : {}),
    raw: {},
    ...extra,
  };
};

/** A fetcher that answers each address from a table of HTML bodies (or a status). */
function fake(pages: Record<string, string | number>) {
  const asked: string[] = [];
  return {
    asked,
    fetcher: {
      get: async (url: string): Promise<Hop[]> => {
        asked.push(url);
        const p = pages[new URL(url).pathname];
        if (typeof p === "number") return [{ url, status: p, headers: {}, body: "", ms: 1 }];
        return [
          {
            url,
            status: p === undefined ? 404 : 200,
            headers: { "content-type": "text/html" },
            body: p ?? "",
            ms: 1,
          },
        ];
      },
      getSite: async () => [],
      stats: { requests: 0, maxInFlight: 0 },
    },
  };
}

describe("built site: unit", () => {
  it("the text compare: curly quotes, non-breaking spaces and dashes are one; a brand suffix is kept", () => {
    expect(textKey("The kiln’s story – Harbour")).toBe(textKey("The kiln's story - Harbour"));
    expect(textKey("Shop | Harbour")).not.toBe(textKey("Shop"));
  });

  it("the canonical is compared on the production host: the preview host and www are this site", () => {
    const r = row(2, "https://harbour.example/classes");
    expect(
      canonicalIsThisPage("https://harbour.example/classes", r, "https://preview.vercel.app"),
    ).toBe(true);
    expect(
      canonicalIsThisPage("https://preview.vercel.app/classes/", r, "https://preview.vercel.app"),
    ).toBe(true);
    expect(
      canonicalIsThisPage("https://www.harbour.example/classes", r, "https://preview.vercel.app"),
    ).toBe(true);
    expect(
      canonicalIsThisPage("https://harbour.example/old-classes", r, "https://preview.vercel.app"),
    ).toBe(false);
    expect(
      canonicalIsThisPage("https://other.example/classes", r, "https://preview.vercel.app"),
    ).toBe(false);
  });
});

describe("built site: integration (the plan-built fixture, a 10-row plan with five planted errors)", () => {
  it("exactly the five planted findings, each with its plan line; three rows on one path are one request", async () => {
    const site = await startFixture("plan-built");
    try {
      const plan = readPlan(readFileSync(`${SITES_DIR}plan-built/plan.csv`, "utf8"));
      const { findings: found, couldNotCheck } = await checkBuilt(plan.rows, {
        base: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        file: "plan.csv",
      });
      expect(couldNotCheck).toEqual([]);
      expect(found.map((f) => [f.checkId, f.group?.lines])).toEqual([
        ["plan-canonical-elsewhere", [8]],
        ["plan-404", [9]],
        ["plan-title-drift", [6]],
        ["plan-h1-drift", [7]],
        ["plan-anchor-missing", [10]],
      ]);
      expect(found.find((f) => f.checkId === "plan-canonical-elsewhere")?.evidence).toBe(
        "/contact: the canonical is https://harbour-pottery.example/contact-us",
      );
      expect(site.hits.get("/classes")).toBe(1);
      expect([...site.methods.keys()]).toEqual(["GET"]);
    } finally {
      await site.close();
    }
  });
});

describe("built site: edge cases", () => {
  it("a preview behind a login (401) is one ConfigError from the probe, not a finding per row", async () => {
    const { fetcher } = fake({ "/": 401, "/a": 401 });
    const rows = [row(2, "https://x.example/"), row(3, "https://x.example/a")];
    await expect(checkBuilt(rows, { base: "https://preview.example", fetcher })).rejects.toThrow(
      ConfigError,
    );
    await expect(checkBuilt(rows, { base: "https://preview.example", fetcher })).rejects.toThrow(
      "Could not check: the preview at https://preview.example asked for a password (401).",
    );
  });

  it("a page with two H1s is compared on the first, with a note", async () => {
    const { fetcher } = fake({ "/a": "<title>A</title><h1>First</h1><h1>Second</h1>" });
    const { findings: found } = await checkBuilt(
      [row(2, "https://x.example/a", { h1: "Second", titleTag: "A" })],
      {
        base: "https://preview.example",
        fetcher,
      },
    );
    expect(found.map((f) => f.evidence)).toEqual([
      '/a: the plan says "Second", the page says "First" (the page has 2 H1s; the first was compared)',
    ]);
  });

  it("a title only set by JavaScript is drift, with a hint", async () => {
    const { fetcher } = fake({ "/a": "<h1>A</h1><script>document.title='A'</script>" });
    const { findings: found } = await checkBuilt(
      [row(2, "https://x.example/a", { titleTag: "A", h1: "A" })],
      {
        base: "https://preview.example",
        fetcher,
      },
    );
    expect(found.map((f) => f.evidence)).toEqual([
      '/a: the plan says "A", the page sends no title tag (it may be set by JavaScript, which this read doesn\'t run)',
    ]);
  });

  it("a plan host on www and a canonical without it are the same page", async () => {
    const { fetcher } = fake({
      "/a": '<link rel="canonical" href="https://x.example/a"><title>A</title>',
    });
    expect(
      await checkBuilt([row(2, "https://www.x.example/a", { titleTag: "A" })], {
        base: "https://preview.example",
        fetcher,
      }),
    ).toEqual({ findings: [], couldNotCheck: [] });
  });
});
