import { describe, expect, it } from "vitest";
import { withFixture } from "../../../fixtures/src/index.js";
import { createFetcher } from "../fetcher.js";
import { checkSite } from "../site.js";

const KINDS = ["page", "link", "image", "sitemap", "feed", "script", "extra-page", "other"];

describe("checkSite: the addresses it requested and what the page declares", () => {
  it("lists one row per request the server saw, by kind, redirect hops included", async () => {
    await withFixture("pages-search", async (site) => {
      const fetcher = createFetcher({ allowPrivate: true });
      const { requests, page } = await checkSite({ address: site.origin, fetcher });
      expect(requests).toBeDefined();
      expect(requests).toHaveLength(site.total);

      const at = (kind: string) => (requests ?? []).filter((r) => r.kind === kind);
      expect(at("page").map((r) => [r.url, r.status])).toEqual([[`${site.origin}/`, 200]]);

      // /moved is a 301 to /moved-again, a 302 to /about, and a 200: three rows, two that moved.
      const moved = at("link").filter((r) => /\/(moved|moved-again|about)$/.test(r.url));
      expect(moved.map((r) => r.status)).toEqual(expect.arrayContaining([301, 302]));
      const first = at("link").find((r) => r.url === `${site.origin}/moved`);
      expect(first).toMatchObject({ status: 301, location: `${site.origin}/moved-again` });
      expect(at("link").find((r) => r.url === `${site.origin}/gone`)?.status).toBe(404);
      expect(at("link").find((r) => r.url === `${site.origin}/busy`)?.status).toBe(500);
      expect(at("link").every((r) => r.method === "HEAD")).toBe(true);

      expect(at("image").map((r) => r.url)).toEqual([
        `${site.origin}/img/mug.png`,
        `${site.origin}/img/missing.png`,
      ]);
      expect(at("image").map((r) => r.status)).toEqual([200, 404]);
      expect(at("sitemap").map((r) => r.url)).toEqual([
        `${site.origin}/`,
        `${site.origin}/about`,
        `${site.origin}/shop`,
      ]);
      expect(at("feed").map((r) => r.url)).toEqual([`${site.origin}/feed.xml`]);
      expect(at("script").map((r) => r.url)).toEqual([`${site.origin}/app.js`]);
      // The other pages read to compare pages are their own kind, and keep their redirect hops.
      expect(at("extra-page").length).toBeGreaterThan(0);
      expect(at("extra-page").every((r) => r.method === "GET")).toBe(true);
      expect(at("other").map((r) => new URL(r.url).pathname)).toEqual(
        expect.arrayContaining(["/robots.txt", "/sitemap.xml"]),
      );

      // Kinds come out in the order the app lists them.
      const kinds = (requests ?? []).map((r) => r.kind);
      expect(kinds).toEqual([...kinds].sort((a, b) => KINDS.indexOf(a) - KINDS.indexOf(b)));

      expect(page).toMatchObject({
        url: `${site.origin}/`,
        title: "Larkspur Pottery Studio",
        canonical: `${site.origin}/`,
      });
      expect(page.words).toBeGreaterThan(30);
      expect(page.firstWords.startsWith("About the studio Shop Classes")).toBe(true);
      expect(page.blocks.map((b) => b.ok)).toEqual([true, true, false]);
    });
  });

  it("the same site lists its requests in the same order twice", async () => {
    await withFixture("pages-search", async (site) => {
      const run = async () => {
        const { requests } = await checkSite({
          address: site.origin,
          fetcher: createFetcher({ allowPrivate: true }),
        });
        return (requests ?? []).map((r) => `${r.kind} ${r.method} ${r.url}`);
      };
      expect(await run()).toEqual(await run());
    });
  });

  it("a fetcher reused for a second check reports only the second check's requests", async () => {
    await withFixture("pages-search", async (site) => {
      const fetcher = createFetcher({ allowPrivate: true });
      const first = await checkSite({ address: site.origin, fetcher });
      const second = await checkSite({ address: `${site.origin}/img/mug.png`, fetcher });
      expect(first.requests?.length).toBeGreaterThan(0);
      expect(second.requests?.[0]?.url).toBe(`${site.origin}/img/mug.png`);
      expect((second.requests ?? []).length).toBeLessThan(first.requests?.length ?? 0);
    });
  });
});
