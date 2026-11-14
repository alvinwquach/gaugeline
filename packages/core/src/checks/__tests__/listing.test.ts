import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import type { FeedRead, SiteContext } from "../../site-context.js";
import { checkSite } from "../../site.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { draftsLive } from "../drafts-live.js";
import { feedDuplicate } from "../feed-duplicate.js";
import { findPagination, mainTextFingerprint } from "../listing/pagination.js";
import { paginationSameContent } from "../pagination-same-content.js";
import { paginationUnreachable } from "../pagination-unreachable.js";

const LISTING = [
  "pagination-unreachable",
  "pagination-same-content",
  "drafts-live",
  "feed-duplicate",
];

function page(url: string, body: string, head = ""): PageSnapshot {
  return buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head>${head}</head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}
const quiet: CheckContext = { warn: () => undefined };
const feed = (url: string, itemLinks: string[]): FeedRead => ({
  url,
  hops: [],
  bytes: 0,
  itemLinks,
});
const withFeeds = (feeds: FeedRead[]): CheckContext => ({
  warn: () => undefined,
  site: async () => ({ feeds }) as unknown as SiteContext,
});

describe("listing: unit", () => {
  it("findPagination: ?page=2, /page/2/, rel=next, and a Load more button with no href", () => {
    expect(
      findPagination(
        page(
          "https://pop.example/blog",
          '<a href="/blog?page=2">2</a> <a href="/blog?page=3">3</a>',
        ),
      ),
    ).toMatchObject({
      pages: ["https://pop.example/blog?page=2", "https://pop.example/blog?page=3"],
      controls: true,
    });
    expect(
      findPagination(
        page(
          "https://pop.example/news/",
          '<a href="/news/page/2/">Older</a> <a href="/about/">About</a>',
        ),
      ).pages,
    ).toEqual(["https://pop.example/news/page/2/"]);
    expect(
      findPagination(page("https://pop.example/blog", "", '<link rel="next" href="/blog?p=2">')),
    ).toMatchObject({
      next: "https://pop.example/blog?p=2",
      pages: ["https://pop.example/blog?p=2"],
    });
    expect(
      findPagination(
        page("https://pop.example/blog", "<ul><li>One</li></ul><button>Load more</button>"),
      ),
    ).toEqual({
      pages: [],
      controls: true,
    });
    expect(findPagination(page("https://pop.example/blog", "<ul><li>One</li></ul>"))).toEqual({
      pages: [],
      controls: false,
    });
  });

  it("mainTextFingerprint ignores a changed timestamp in the footer and a different active state in the nav", () => {
    const a = mainTextFingerprint(
      '<nav><a class="active">Page 1</a></nav><main><p>Post A</p></main><footer>Built 10:01</footer>',
    );
    const b = mainTextFingerprint(
      '<nav><a>Page 1</a><a class="active">Page 2</a></nav><main><p>Post   A</p></main><footer>Built 10:02</footer>',
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(mainTextFingerprint("<main><p>Post B</p></main>")).not.toBe(a);
  });

  it("feed-duplicate: same items in a different order is a duplicate; one extra item is not; two empty feeds are not", async () => {
    const items = ["https://pop.example/a", "https://pop.example/b"];
    const p = page("https://pop.example/", "");
    expect(
      (
        await feedDuplicate.run(
          p,
          withFeeds([
            feed("https://pop.example/news.xml", items),
            feed("https://pop.example/blog.xml", [...items].reverse()),
          ]),
        )
      ).map((f) => f.evidence),
    ).toEqual(["/news.xml and /blog.xml list the same 2 items"]);
    expect(
      await feedDuplicate.run(
        p,
        withFeeds([
          feed("https://pop.example/news.xml", items),
          feed("https://pop.example/blog.xml", [...items, "https://pop.example/c"]),
        ]),
      ),
    ).toEqual([]);
    expect(
      await feedDuplicate.run(
        p,
        withFeeds([
          feed("https://pop.example/news.xml", []),
          feed("https://pop.example/blog.xml", []),
        ]),
      ),
    ).toEqual([]);
  });
});

describe("listing: integration (the paged-list fixture)", () => {
  it("?page=2 serves page 1 again, a draft id in a data attribute, two feeds with the same posts; at most 2 extra page requests", async () => {
    const site = await startFixture("paged-list");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: LISTING,
      });
      expect(result.findings.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
        ["drafts-live", "high", '1 draft document id in the published HTML, first "drafts.abc123"'],
        ["pagination-same-content", "high", "/?page=2 shows the same list as /"],
        ["feed-duplicate", "medium", "/news.xml and /blog.xml list the same 3 items"],
      ]);
      // "/" is served for every page number: the page itself, then at most 2 more.
      expect(site.hits.get("/")).toBeLessThanOrEqual(3);
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("a Load more button with no address: pagination-unreachable", async () => {
    const p = page(
      "https://pop.example/blog",
      '<main><article>One</article></main><button class="load-more">Load more</button>',
    );
    expect((await paginationUnreachable.run(p, quiet)).map((f) => f.evidence)).toEqual([
      'a "Load more" control, and no address for page 2 in the HTML',
    ]);
  });
});

describe("listing: edge cases", () => {
  it("page 2 returns 404: that is a broken link (G10), not pagination-same-content", async () => {
    const fetcher = {
      get: async (url: string) => [{ url, status: 404, headers: {}, body: "", ms: 1 }],
      getSite: async () => [],
      stats: { requests: 0, maxInFlight: 0 },
    };
    const p = page("https://pop.example/blog", '<main>One</main><a href="/blog?page=2">2</a>');
    const { createBudget } = await import("../../limits.js");
    expect(
      await paginationSameContent.run(p, {
        warn: () => undefined,
        fetcher,
        budget: createBudget(),
      }),
    ).toEqual([]);
  });

  it("a list with one page and no controls produces nothing", async () => {
    const p = page("https://pop.example/blog", "<main><article>Only post</article></main>");
    expect(await paginationUnreachable.run(p, quiet)).toEqual([]);
    expect(await paginationSameContent.run(p, quiet)).toEqual([]);
  });

  it("infinite scroll with no links and no controls is not detectable, so nothing is reported", async () => {
    const p = page(
      "https://pop.example/blog",
      '<main><div id="feed" data-infinite="true"><article>One</article></div></main>',
    );
    expect(await paginationUnreachable.run(p, quiet)).toEqual([]);
  });

  it('"drafts." inside article prose is not drafts-live; ids in attributes and JSON values are', async () => {
    expect(
      await draftsLive.run(
        page(
          "https://pop.example/",
          "<main><p>We keep drafts.  Our drafts.v2 folder is tidy.</p></main>",
        ),
        quiet,
      ),
    ).toEqual([]);
    const json = page(
      "https://pop.example/",
      `<main>Post</main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { doc: { _id: "drafts.post-7", title: "Secret plans" }, other: "drafts.post-7" } })}</script>`,
    );
    const out = await draftsLive.run(json, quiet);
    expect(out.map((f) => f.evidence)).toEqual([
      '1 draft document id in the published HTML, first "drafts.post-7"',
    ]);
    expect(JSON.stringify(out)).not.toContain("Secret plans");
    const banner = page(
      "https://pop.example/",
      '<div class="banner">Preview mode is on. <a href="/api/exit-preview">Exit preview</a></div><main>Post</main>',
    );
    expect((await draftsLive.run(banner, quiet)).map((f) => f.evidence)).toEqual([
      'a preview-mode banner in the published HTML: "Preview mode"',
    ]);
  });

  it("a news feed and a blog feed that share 9 of 10 items are not duplicates", async () => {
    const shared = Array.from({ length: 9 }, (_, i) => `https://pop.example/p${i}`);
    expect(
      await feedDuplicate.run(
        page("https://pop.example/", ""),
        withFeeds([
          feed("https://pop.example/news.xml", [...shared, "https://pop.example/news-only"]),
          feed("https://pop.example/blog.xml", [...shared, "https://pop.example/blog-only"]),
        ]),
      ),
    ).toEqual([]);
  });
});
