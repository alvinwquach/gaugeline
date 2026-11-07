import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import {
  createLimiter,
  domainFetcher,
  handleCheckRedirects,
  liveCheck,
  LiveRefusal,
} from "../check-redirects.js";
import {
  LIVE_LIMIT,
  lintPlan,
  lintRedirects,
  parsePlanSheet,
  parseRedirectList,
  ShapeError,
  type ListRow,
} from "../lint.js";

const LIST = readFileSync(
  new URL("../../../../fixtures/redirects/redirect-list.csv", import.meta.url),
  "utf8",
);
const rows = (text: string) => parseRedirectList(text);
const rules = (text: string) => lintRedirects(rows(text)).map((i) => [i.rule, i.lines]);

describe("free tools: unit (each lint rule)", () => {
  it("the fixture list: its duplicate, its chain and its self-pointing row, and nothing else", () => {
    expect(lintRedirects(rows(LIST)).map((i) => i.message)).toEqual([
      "/old-gifts is listed 2 times with different destinations (lines 5, 6): a server uses only one of them",
      "Line 8: /about-us → /old-about, which line 7 redirects again to /about: point /about-us straight at /about",
      "Line 9: /press redirects to itself (/press): a loop for every visitor",
    ]);
  });

  it("duplicate: the same old address twice, with or without a trailing slash or the host", () => {
    expect(rules("/a,/b\n/a/,/b\nhttps://www.shop.example/a,/b")).toEqual([
      ["duplicate", [1, 2, 3]],
      ["mixed-slash", [2]],
    ]);
  });

  it("chain: a destination that is another row's old address", () => {
    expect(rules("/a,/b\n/b,/c")).toEqual([["chain", [1, 2]]]);
  });

  it("self: exactly the same address, while /kids/ to /kids is a redirect, not a loop", () => {
    expect(rules("/press,/press")).toEqual([["self", [1]]]);
    expect(rules("/kids/,/kids").map(([r]) => r)).toEqual(["mixed-slash"]);
  });

  it("mixed trailing slashes: once for the list, naming the lines with a slash", () => {
    expect(rules("/a/,/b/\n/c,/d")).toEqual([["mixed-slash", [1]]]);
    expect(rules("/a/,/b/\n/c/,/d/")).toEqual([]);
    expect(rules("/a,/b.html\n/c,/")).toEqual([]);
  });

  it("a spreadsheet paste (tabs), arrows and a header named Old/New all read the same", () => {
    const want = [{ line: 2, from: "/a", to: "/b" }];
    expect(rows("Old URL\tNew URL\n/a\t/b")).toEqual(want);
    expect(rows("source,destination\n/a,/b")).toEqual(want);
    expect(rows("/x → /y")).toEqual([{ line: 1, from: "/x", to: "/y" }]);
  });

  it("the plan sheet: an old address with no destination, two rows sharing one title", () => {
    const plan = parsePlanSheet(
      "Old URL,New URL,Title\n/old-a,/a,Fiction | Lantern\n/old-b,,Poetry\n/old-c,/c,fiction | lantern\n,/d,Kids",
    );
    expect(lintPlan(plan).map((i) => [i.rule, i.lines, i.message])).toEqual([
      [
        "shared-title",
        [2, 4],
        'Lines 2, 4 share the title "Fiction | Lantern": search results can\'t tell the pages apart',
      ],
      ["no-destination", [3], "Line 3: /old-b has no new address: after launch it answers 404"],
    ]);
  });
});

describe("free tools: integration (the live check, on fixture sites)", () => {
  it("the function refuses a list that spans more than one domain, before any request", async () => {
    let requests = 0;
    const list: ListRow[] = [
      { line: 2, from: "/old-fiction", to: "/fiction" },
      { line: 3, from: "https://blog.example/old", to: "/new" },
    ];
    await expect(
      liveCheck(
        { domain: "lanternbooks.example", rows: list },
        {
          fetcher: {
            get: () => (requests++, Promise.reject(new Error("no"))),
            getSite: () => Promise.reject(new Error("no")),
            requestCount: () => 0,
          } as never,
        },
      ),
    ).rejects.toThrow(
      "The list spans more than one domain (lanternbooks.example, blog.example): the live check only requests addresses on the domain you typed, lanternbooks.example.",
    );
    expect(requests).toBe(0);
  });

  it("the same redirect-map code as the command: a 302 is reported, the 301s pass", async () => {
    const site = await startFixture("redirect-tool");
    try {
      const r = await liveCheck(
        { domain: "lanternbooks.example", rows: rows(LIST).slice(0, 3) },
        { fetcherOptions: { hosts: site.hosts }, scheme: "http" },
      );
      expect(r.findings.map((f) => [f.line, f.checkId, f.evidence])).toEqual([
        [4, "plan-redirect-not-301", "/old-poetry redirects with 302, not 301"],
      ]);
      expect([r.checked, r.skipped]).toEqual([3, 0]);
      expect([...site.methods.keys()]).toEqual(["GET"]);
    } finally {
      await site.close();
    }
  });

  it("a hop to another host is never sent", async () => {
    let sent: string[] = [];
    const fetcher = domainFetcher("lanternbooks.example", {
      transport: async (url) => {
        sent.push(url.host);
        return {
          status: 301,
          headers: { location: "https://elsewhere.example/x" },
          body: (await import("node:stream")).Readable.from([]),
        };
      },
    });
    await fetcher.get("https://lanternbooks.example/a").catch(() => undefined);
    expect(sent).toEqual(["lanternbooks.example"]);
    sent = [];
  });

  it("the handler: POST only, a limit per visitor, and refusals as plain messages", async () => {
    const limiter = createLimiter({ max: 2, windowMs: 60_000, now: () => 0 });
    const post = (body: unknown) =>
      handleCheckRedirects(
        new Request("https://site.invalid/api", { method: "POST", body: JSON.stringify(body) }),
        { limiter, visitor: "203.0.113.9" },
      );
    expect(
      (
        await handleCheckRedirects(new Request("https://site.invalid/api"), {
          limiter,
          visitor: "x",
        })
      ).status,
    ).toBe(405);
    const spans = await post({
      domain: "lanternbooks.example",
      rows: [{ line: 2, from: "https://other.example/a", to: "/b" }],
    });
    expect([spans.status, ((await spans.json()) as { error: string }).error]).toEqual([
      400,
      expect.stringContaining("The list spans more than one domain"),
    ]);
    expect((await post({ domain: "x", rows: [] })).status).toBe(400);
    expect((await post({ domain: "x", rows: [] })).status).toBe(429);
  });
});

describe("free tools: edge cases", () => {
  it("5,000 rows are linted locally; the live check takes the first 25 and says how many were left", async () => {
    const big = ["From,To", ...Array.from({ length: 5000 }, (_, i) => `/old-${i},/new-${i}`)].join(
      "\n",
    );
    const started = performance.now();
    const list = rows(big);
    expect(lintRedirects(list)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
    let asked = 0;
    const r = await liveCheck(
      { domain: "lanternbooks.example", rows: list },
      {
        fetcher: {
          get: async (u: string) => (
            asked++,
            [
              { url: u, status: 301, headers: { location: u.replace("old", "new") }, ms: 0 },
              { url: u.replace("old", "new"), status: 200, headers: {}, ms: 0 },
            ]
          ),
          getSite: async () => [],
          requestCount: () => 0,
        } as never,
      },
    );
    expect([asked, r.checked, r.skipped]).toEqual([LIVE_LIMIT, LIVE_LIMIT, 4975]);
  });

  it("a file in the wrong shape gets a plain explanation", () => {
    expect(() => rows("Name,Price\nMug,12")).toThrow(ShapeError);
    expect(() => rows("Name,Price\nMug,12")).toThrow(
      'The first line ("Name, Price") isn\'t a redirect or a header the tool knows. Put the old address first and the new one second, one redirect per line (/old-page,/new-page), or name the columns From and To.',
    );
    expect(() => rows("From,To\n/a,b")).toThrow(
      "Line 2 isn't a redirect: each line needs an old address and a new one, each starting with / or https://",
    );
    expect(() => rows("")).toThrow("The list is empty");
    expect(() => parsePlanSheet("Page,URL\nHome,/")).toThrow(
      'The first line needs three column names: the old address (Old URL), the new address (New URL) and the title (Title). It has "Page", "URL".',
    );
  });

  it("a domain that isn't one is refused in words", async () => {
    await expect(liveCheck({ domain: "not a domain", rows: [] })).rejects.toBeInstanceOf(
      LiveRefusal,
    );
  });
});
