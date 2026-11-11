import { describe, expect, it } from "vitest";
import { ConfigError } from "../../errors.js";
import { createFetcher } from "../../fetcher.js";
import { readOldSite } from "../old-site.js";
import { OLD_ORIGIN, wpBody, world, type Recorded } from "./world.js";

const asked = (w: ReturnType<typeof world>) => w.seen.map((s) => `${s.method} ${s.url}`);

describe("readOldSite", () => {
  it("reads the WordPress REST API: posts and pages, published only, GET only, no key", async () => {
    const w = world();
    const list = await readOldSite(createFetcher({ transport: w.transport }), OLD_ORIGIN);
    expect(list.source).toBe("wordpress");
    expect(list.items).toHaveLength(12);
    expect(list.items.find((i) => i.path === "/2026/08/new-rye-loaf/")).toEqual({
      path: "/2026/08/new-rye-loaf/",
      title: "The new rye loaf",
      kind: "post",
    });
    expect(list.notes[0]).toBe("Read 8 posts and 4 pages from the old site's WordPress API.");
    const urls = asked(w);
    expect(urls.every((u) => u.startsWith("GET "))).toBe(true);
    expect(
      urls.some((u) => u.includes("/wp-json/wp/v2/posts?") && u.includes("status=publish")),
    ).toBe(true);
    expect(w.seen.every((s) => !s.url.includes("/wp-admin") && !s.url.includes("/wp-login"))).toBe(
      true,
    );
  });

  it("follows the API's pages, and keeps the posts when the pages cannot be read", async () => {
    const page = (n: number): Recorded => ({
      status: 200,
      headers: { "content-type": "application/json", "x-wp-totalpages": "2" },
      body: JSON.stringify(
        Array.from({ length: n === 1 ? 100 : 5 }, (_, k) => ({
          link: `${OLD_ORIGIN}/p/${n}-${k}/`,
          title: { rendered: `Post ${n}-${k}` },
          status: "publish",
        })),
      ),
    });
    const w = world({
      wordpress: false,
      routes: {
        [`${OLD_ORIGIN}/wp-json/wp/v2/posts`]: page(1),
        [`${OLD_ORIGIN}/wp-json/wp/v2/posts?per_page=100&page=2&status=publish&_fields=link,title,type,status`]:
          page(2),
      },
    });
    const list = await readOldSite(createFetcher({ transport: w.transport }), OLD_ORIGIN);
    expect(list.source).toBe("wordpress");
    expect(list.items).toHaveLength(105);
    expect(list.notes[0]).toBe("Read 105 posts and 0 pages from the old site's WordPress API.");
    // page=2 of the posts is asked once the header says there are two
    expect(asked(w).some((u) => u.includes("posts?per_page=100&page=2"))).toBe(true);
  });

  it("falls back to the sitemap, an index followed one level, when there is no WordPress API", async () => {
    const w = world({
      wordpress: false,
      routes: {
        [`${OLD_ORIGIN}/sitemap.xml`]: {
          status: 200,
          body: `<sitemapindex><sitemap><loc>${OLD_ORIGIN}/s1.xml</loc></sitemap></sitemapindex>`,
        },
        [`${OLD_ORIGIN}/s1.xml`]: {
          status: 200,
          body: `<urlset><url><loc>${OLD_ORIGIN}/</loc></url><url><loc>${OLD_ORIGIN}/menu/</loc></url><url><loc>${OLD_ORIGIN}/?p=9</loc></url></urlset>`,
        },
      },
    });
    const list = await readOldSite(createFetcher({ transport: w.transport }), OLD_ORIGIN);
    expect(list.source).toBe("sitemap");
    expect(list.items.map((i) => i.path)).toEqual(["/", "/menu/"]);
    expect(list.items.some((i) => i.title !== undefined)).toBe(false);
    expect(list.notes.join(" ")).toContain("1 address was left out: 1 with a query string");
  });

  it("falls back to the home page's links, one level, when there is no sitemap either", async () => {
    const w = world({
      wordpress: false,
      routes: {
        [`${OLD_ORIGIN}/`]: {
          status: 200,
          headers: { "content-type": "text/html" },
          body: `<a href="/menu/">Menu</a><a href="${OLD_ORIGIN}/visit/">Visit</a><a href="/logo.png">x</a><a href="https://elsewhere.example/">y</a><a href="#top">top</a>`,
        },
      },
    });
    const list = await readOldSite(createFetcher({ transport: w.transport }), OLD_ORIGIN);
    expect(list.source).toBe("links");
    expect(list.items.map((i) => i.path).sort()).toEqual(["/", "/menu/", "/visit/"]);
  });

  it("says how to give a list by hand when nothing gives one", async () => {
    const w = world({ wordpress: false, items: [] });
    await expect(
      readOldSite(createFetcher({ transport: w.transport }), OLD_ORIGIN),
    ).rejects.toThrow(ConfigError);
    await expect(
      readOldSite(createFetcher({ transport: w.transport }), OLD_ORIGIN),
    ).rejects.toThrow(/Could not read a list of pages from wrenbakehouse.example/);
  });

  it("does not take a theme's HTML at /wp-json for the API", async () => {
    const w = world({
      wordpress: false,
      routes: {
        [`${OLD_ORIGIN}/wp-json/wp/v2/posts`]: { status: 200, body: "<html>Not found</html>" },
        [`${OLD_ORIGIN}/sitemap.xml`]: {
          status: 200,
          body: `<urlset><url><loc>${OLD_ORIGIN}/a/</loc></url></urlset>`,
        },
      },
    });
    const list = await readOldSite(createFetcher({ transport: w.transport }), OLD_ORIGIN);
    expect(list.source).toBe("sitemap");
  });

  it("a list in the API's own shape is what wpBody writes", () => {
    expect(JSON.parse(wpBody("page"))).toHaveLength(4);
  });
});
