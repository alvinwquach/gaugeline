import { describe, expect, it } from "vitest";
import type { Hop } from "../../fetcher.js";
import { checkBuilt } from "../built.js";
import type { PlanRow } from "../read.js";

const row = (line: number, path: string, legacyUrl?: string): PlanRow => ({
  line,
  url: `https://harbour-clinic.example${path}`,
  path,
  raw: {},
  ...(legacyUrl ? { legacyUrl } : {}),
});

interface Page {
  status?: number;
  head?: string;
  headers?: Record<string, string>;
}
const doc = (head = "") =>
  `<!doctype html><html><head><title>t</title>${head}</head><body><h1>h</h1></body></html>`;

/** A fetcher answering from a table by path: pages, and /robots.txt as text. */
function site(pages: Record<string, Page>, robots?: string) {
  const asked: string[] = [];
  return {
    asked,
    fetcher: {
      get: async (url: string): Promise<Hop[]> => {
        asked.push(new URL(url).pathname);
        const path = new URL(url).pathname;
        if (path === "/robots.txt")
          return [
            {
              url,
              status: robots === undefined ? 404 : 200,
              headers: { "content-type": "text/plain" },
              body: robots ?? "",
              ms: 1,
            },
          ];
        const p = pages[path];
        return [
          {
            url,
            status: p ? (p.status ?? 200) : 404,
            headers: { "content-type": "text/html", ...(p?.headers ?? {}) },
            body: doc(p?.head),
            ms: 1,
          },
        ];
      },
      getSite: async () => [],
      stats: { requests: 0, maxInFlight: 0 },
    },
  };
}
const run = (rows: PlanRow[], s: ReturnType<typeof site>) =>
  checkBuilt(rows, { base: "https://preview.harbour-clinic.example", fetcher: s.fetcher as never });
const ids = (r: Awaited<ReturnType<typeof run>>) =>
  r.findings.filter((f) => f.checkId === "plan-moved-not-indexable");

const NOINDEX = '<meta name="robots" content="noindex, nofollow">';

describe("plan-moved-not-indexable: which pages it judges", () => {
  it("a moved page set to noindex is a finding that names the old address and the reason", async () => {
    const s = site({
      "/": {},
      "/physio": { head: NOINDEX },
      "/rehab": {},
    });
    const r = await run(
      [row(2, "/"), row(3, "/physio", "/old/physiotherapy"), row(4, "/rehab", "/old/rehab")],
      s,
    );
    expect(ids(r)).toHaveLength(1);
    expect(ids(r)[0]).toMatchObject({
      severity: "high",
      group: { key: "/physio", lines: [3] },
    });
    expect(ids(r)[0]?.evidence).toBe(
      '/physio (moved from /old/physiotherapy) says noindex in <meta name="robots" content="noindex, nofollow">',
    );
    expect(r.couldNotCheck).toEqual([]);
  });

  it("a page that is not moved is never judged, however it is set", async () => {
    const s = site({ "/": {}, "/physio": { head: NOINDEX }, "/rehab": {} });
    const r = await run([row(2, "/"), row(3, "/physio"), row(4, "/rehab", "/old/rehab")], s);
    expect(ids(r)).toEqual([]);
  });

  it("a legacy address equal to the row's own path is not a move", async () => {
    const s = site({ "/": {}, "/physio": { head: NOINDEX }, "/rehab": {} });
    const r = await run([row(2, "/"), row(3, "/physio", "/physio"), row(4, "/rehab")], s);
    expect(ids(r)).toEqual([]);
  });

  it("noindex in the X-Robots-Tag header counts, including a bot-named directive", async () => {
    const s = site({
      "/": {},
      "/a": { headers: { "x-robots-tag": "noindex" } },
      "/b": { headers: { "x-robots-tag": "googlebot: noindex, nofollow" } },
      "/c": { headers: { "x-robots-tag": "nosnippet" } },
    });
    const r = await run(
      [row(2, "/"), row(3, "/a", "/o/a"), row(4, "/b", "/o/b"), row(5, "/c", "/o/c")],
      s,
    );
    expect(ids(r).map((f) => f.group?.key)).toEqual(["/a", "/b"]);
    expect(ids(r)[0]?.evidence).toContain("the X-Robots-Tag header (noindex)");
  });

  it("robots.txt that blocks a moved page's path for Googlebot is a finding, and an allow rule that is longer wins", async () => {
    const s = site(
      { "/": {}, "/clinic/hours": {}, "/clinic/team": {} },
      "User-agent: *\nDisallow: /clinic/\nAllow: /clinic/team\n",
    );
    const r = await run(
      [row(2, "/"), row(3, "/clinic/hours", "/old/hours"), row(4, "/clinic/team", "/old/team")],
      s,
    );
    expect(ids(r)).toHaveLength(1);
    expect(ids(r)[0]?.evidence).toBe(
      "/clinic/hours (moved from /old/hours) is blocked by robots.txt (Disallow: /clinic/)",
    );
  });

  it("asks for robots.txt once, and only when the plan has a moved page", async () => {
    const withMove = site({ "/": {}, "/a": {} });
    await run([row(2, "/"), row(3, "/a", "/o/a")], withMove);
    expect(withMove.asked.filter((p) => p === "/robots.txt")).toHaveLength(1);
    const without = site({ "/": {}, "/a": {} });
    await run([row(2, "/"), row(3, "/a")], without);
    expect(without.asked).not.toContain("/robots.txt");
  });

  it("a robots.txt that does not exist, or fails, blocks nothing", async () => {
    const s = site({ "/": {}, "/a": {} });
    expect(ids(await run([row(2, "/"), row(3, "/a", "/o/a")], s))).toEqual([]);
  });

  it("a moved page that does not exist is plan-404 only, never also not indexable", async () => {
    const s = site({ "/": {} });
    const r = await run([row(2, "/"), row(3, "/gone", "/o/gone")], s);
    expect(ids(r)).toEqual([]);
    expect(r.findings.map((f) => f.checkId)).toContain("plan-404");
  });

  it("several moved rows on one page are one finding with every line", async () => {
    const s = site({ "/": {}, "/a": { head: NOINDEX } });
    const r = await run([row(2, "/"), row(3, "/a", "/o/a"), row(4, "/a", "/o/a2")], s);
    expect(ids(r)).toHaveLength(1);
    expect(ids(r)[0]?.group?.lines).toEqual([3, 4]);
  });
});

describe("plan-moved-not-indexable: a preview that is hidden as a whole", () => {
  it("when every page read says noindex it is the preview's switch: could not check, no finding", async () => {
    const s = site({ "/": { head: NOINDEX }, "/a": { head: NOINDEX }, "/b": { head: NOINDEX } });
    const r = await run([row(2, "/"), row(3, "/a", "/o/a"), row(4, "/b", "/o/b")], s);
    expect(ids(r)).toEqual([]);
    expect(r.couldNotCheck.map((c) => c.url)).toEqual([
      "https://preview.harbour-clinic.example/a",
      "https://preview.harbour-clinic.example/b",
    ]);
    expect(r.couldNotCheck[0]?.reason).toBe(
      "every page read on the preview is set not to be indexed, so a moved page's own setting can't be told from the preview's: run the plan again against the live site after launch",
    );
    expect(r.couldNotCheck[0]?.lines).toEqual([3]);
  });

  it("every page blocked by robots.txt is the same: could not check", async () => {
    const s = site({ "/": {}, "/a": {} }, "User-agent: *\nDisallow: /\n");
    const r = await run([row(2, "/"), row(3, "/a", "/o/a")], s);
    expect(ids(r)).toEqual([]);
    expect(r.couldNotCheck).toHaveLength(1);
  });

  it("one page alone cannot show a preview-wide switch: it is reported", async () => {
    const s = site({ "/a": { head: NOINDEX } });
    const r = await run([row(2, "/a", "/o/a")], s);
    expect(ids(r)).toHaveLength(1);
  });

  it("the guard compares pages read: a not-found page is not one of them", async () => {
    const s = site({ "/a": { head: NOINDEX }, "/b": { head: NOINDEX } });
    const r = await run([row(2, "/a", "/o/a"), row(3, "/b", "/o/b"), row(4, "/missing")], s);
    expect(ids(r)).toEqual([]);
    expect(r.couldNotCheck).toHaveLength(2);
  });
});
