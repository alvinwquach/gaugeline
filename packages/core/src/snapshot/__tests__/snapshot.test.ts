import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { buildRunSnapshot } from "../../run-snapshot.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { contentGains, lostContent, lostItems, lostTypes } from "../compare.js";
import { mainContent } from "../main-content.js";
import { readNow } from "../now.js";
import { buildContentSnapshot, type ContentSnapshot } from "../page-snapshot.js";

const PAGE_IDS = ["page-gone", "page-lost-content", "page-lost-items", "page-lost-structured-data"];
const hop = (body: string, url = "https://kiln.example/a", status = 200, location?: string): Hop =>
  ({
    url,
    status,
    headers: { "content-type": "text/html", ...(location ? { location } : {}) },
    body,
    ms: 1,
  }) as Hop;
const snap = (html: string, url = "https://kiln.example/a") =>
  buildContentSnapshot(buildSnapshot([hop(html, url)]));
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const shell = (main: string, footer = "<a href='/privacy'>Privacy</a>") =>
  `<html><body><header><nav><a href="/a">A</a> menu words here</nav></header><main>${main}</main><footer>${footer} footer words</footer></body></html>`;

describe("page snapshots: unit", () => {
  it("main content leaves out the header, footer, navigation and asides", () => {
    const m = mainContent(
      `<body><header>Brand name here</header><nav>Home About Shop</nav><main><h1>Title</h1><p>one two three</p><aside>related links here</aside><nav>crumbs</nav></main><footer>Privacy Terms</footer></body>`,
      "https://kiln.example/",
    );
    expect(m.words).toBe(4);
  });

  it("with no main element, the body without its header and footer", () => {
    const m = mainContent(
      `<body><header>Brand</header><p>one two</p><div role="navigation">x y z</div><footer>f</footer></body>`,
      "https://kiln.example/",
    );
    expect(m.words).toBe(2);
  });

  it("counts list items: a list of 3 or more, its item links, a [data-list] of any length", () => {
    const m = mainContent(
      `<main><h2>Pots</h2><ul><li><a href="/p/a">A</a></li><li><a href="/p/b#x">B</a></li><li>C</li></ul>
       <ul><li>two</li><li>items</li></ul>
       <div data-list="Team"><article>Ann</article><article>Bo</article></div></main>`,
      "https://kiln.example/",
    );
    expect(m.lists).toEqual([
      {
        key: "Pots",
        items: 3,
        links: ["https://kiln.example/p/a", "https://kiln.example/p/b"],
        paginated: false,
      },
      { key: "Team", items: 2, links: [], paginated: false },
    ]);
  });

  it("the 40% boundary: exactly 40% fewer words is not a loss, one word more is", () => {
    const before = snap(shell(`<p>${words(100)}</p>`));
    expect(lostContent(before, snap(shell(`<p>${words(60)}</p>`)))).toBeUndefined();
    expect(lostContent(before, snap(shell(`<p>${words(59)}</p>`)))).toBe(
      "100 words, now 59 (−41%)",
    );
  });

  it("a section gone is a loss even when the words barely fell", () => {
    const before = snap(
      shell(`<h2>Studio</h2><p>${words(50)}</p><h2>Awards</h2><p>${words(5)}</p>`),
    );
    const after = snap(shell(`<h2>Studio</h2><p>${words(50)}</p>`));
    expect(lostContent(before, after)).toBe('57 words, now 51 (−11%); section gone: "Awards"');
  });

  it("a snapshot keeps counts and names, never the page's text", () => {
    const s = snap(
      shell(
        `<h1>T</h1><p>secret sentence</p><img src="/i.png" alt=""><script type="application/ld+json">{"@type":["Product","Thing"]}</script>`,
      ),
    );
    expect(JSON.stringify(s)).not.toContain("secret");
    expect(s.types).toEqual(["Product", "Thing"]);
    expect([s.images, s.links]).toEqual([1, 2]);
  });

  it("where a saved address leads now: gone, redirected elsewhere, the same page, unread", () => {
    expect(readNow([hop("", "https://kiln.example/a", 404)], "/a")).toEqual({
      kind: "gone",
      status: 404,
    });
    expect(
      readNow(
        [hop("", "https://kiln.example/a", 301, "/b"), hop("<p>x</p>", "https://kiln.example/b")],
        "/a",
      ),
    ).toEqual({ kind: "gone", status: 301, leadsTo: "/b" });
    expect(
      readNow(
        [hop("", "https://kiln.example/a", 301, "/a/"), hop("<p>x</p>", "https://kiln.example/a/")],
        "/a",
      ).kind,
    ).toBe("page");
    expect(readNow([hop("", "https://kiln.example/a", 503)], "/a")).toEqual({
      kind: "unread",
      reason: "answered 503",
    });
  });
});

describe("page snapshots: integration (the pottery studio before and after)", () => {
  const run = async (name: string, previous?: ReturnType<typeof buildRunSnapshot>) => {
    const site = await startFixture(name);
    try {
      return await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: PAGE_IDS,
        baselineRequested: true,
        ...(previous ? { previous } : {}),
      });
    } finally {
      await site.close();
    }
  };

  it("the section lost, the list from 12 to 7, the structured data gone, the page gone; nothing else", async () => {
    const before = await run("snap-before");
    // A first run: nothing saved yet, so every page check is could not check, never a pass.
    expect(before.result.findings).toEqual([]);
    expect(before.result.couldNotCheck.map((c) => c.id)).toEqual(PAGE_IDS);
    expect(Object.keys(before.contents ?? {})).toEqual([
      "/",
      "/about",
      "/classes",
      "/glazes",
      "/shop",
    ]);
    const previous = buildRunSnapshot(before.snapshot, () => new Date(0), before.contents);
    const after = await run("snap-after", previous);
    expect(
      after.result.findings.map((f) => [f.checkId, new URL(f.url).pathname, f.evidence]),
    ).toEqual([
      [
        "page-gone",
        "/classes",
        "/classes redirects with 301 to /gift-cards now; last run it was a page of its own",
      ],
      ["page-lost-content", "/about", '139 words, now 101 (−27%); section gone: "Awards"'],
      [
        "page-lost-items",
        "/shop",
        'the list "Pots for sale" had 12 items, now 7; gone: /shop/nesting-bowls, /shop/butter-dish, /shop/olive-dish, /shop/serving-platter, /shop/bud-vase',
      ],
      [
        "page-lost-structured-data",
        "/glazes",
        "/glazes had Article structured data last run; the page has none now",
      ],
    ]);
    expect(after.result.couldNotCheck).toEqual([]);
    expect(after.contentNotes).toEqual(["New page: /gift-cards"]);
    expect(Object.keys(after.contents ?? {})).toEqual([
      "/",
      "/about",
      "/gift-cards",
      "/glazes",
      "/shop",
    ]);
  });

  it("a page listed under expectedChanges is left out, and said once as information", async () => {
    const before = await run("snap-before");
    const site = await startFixture("snap-after");
    try {
      const after = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: PAGE_IDS,
        baselineRequested: true,
        previous: buildRunSnapshot(before.snapshot, () => new Date(0), before.contents),
        pagesConfig: {
          expectedChanges: [{ path: "/about/", reason: "the awards moved to /press" }],
        },
      });
      expect(after.result.findings.map((f) => f.checkId)).not.toContain("page-lost-content");
      expect(after.contentNotes).toContain(
        "Expected change, not reported: /about/ (the awards moved to /press)",
      );
    } finally {
      await site.close();
    }
  });
});

describe("page snapshots: edge cases", () => {
  it("words reordered but not removed: no loss", () => {
    const before = snap(shell(`<h2>One</h2><p>a b c d</p><h2>Two</h2><p>e f g h</p>`));
    const after = snap(shell(`<h2>Two</h2><p>h g f e</p><h2>One</h2><p>d c b a</p>`));
    expect(lostContent(before, after)).toBeUndefined();
  });

  it("a paginated listing: the first page is compared, and the evidence says so", () => {
    const list = (n: number) =>
      `<h2>Journal</h2><ol>${Array.from({ length: n }, (_, i) => `<li><a href="/j/${i}">Post ${i}</a></li>`).join("")}</ol><a rel="next" href="?page=2">Older</a>`;
    const before = snap(shell(list(10)));
    expect(before.lists[0]?.paginated).toBe(true);
    expect(lostItems(before, snap(shell(list(10))))).toEqual([]);
    expect(lostItems(before, snap(shell(list(8))))).toEqual([
      'the list "Journal" had 10 items, now 8; gone: /j/8, /j/9 (a paginated list: the first page is compared)',
    ]);
  });

  it("a page new in the second run is a gain, never a finding", () => {
    const a = snap(shell("<p>x</p>"));
    expect(contentGains({ "/a": a }, { "/a": a, "/b": a })).toEqual(["New page: /b"]);
  });

  it("a footer that changed on every page changes nothing", () => {
    const html = (footer: string) =>
      shell(`<h2>Pots</h2><ul><li>a</li><li>b</li><li>c</li></ul><p>${words(20)}</p>`, footer);
    const before: ContentSnapshot = snap(html("<a href='/privacy'>Privacy</a>"));
    const after = snap(
      html(
        `<h3>Studio</h3><p>${words(80)}</p><ul><li><a href="/x">X</a></li><li>Y</li><li>Z</li></ul>`,
      ),
    );
    expect([
      lostContent(before, after),
      lostItems(before, after),
      lostTypes(before, after),
    ]).toEqual([undefined, [], []]);
    expect(contentGains({ "/a": before }, { "/a": after })).toEqual([]);
  });

  it("without --since last the page checks say nothing; with it and no saved pages, could not check", async () => {
    const site = await startFixture("snap-before");
    try {
      const base = {
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: PAGE_IDS,
      };
      const silent = await checkSite(base);
      expect([silent.result.findings, silent.result.couldNotCheck, silent.contents]).toEqual([
        [],
        [],
        undefined,
      ]);
      const old = await checkSite({
        ...base,
        baselineRequested: true,
        previous: { ...buildRunSnapshot(silent.snapshot), pages: undefined } as never,
      });
      expect(old.result.couldNotCheck.map((c) => c.reason)).toEqual(
        PAGE_IDS.map(() => "the last run's snapshot has no saved pages: this run saves them"),
      );
    } finally {
      await site.close();
    }
  });
});
