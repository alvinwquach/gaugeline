import { describe, expect, it } from "vitest";
import { authorTierLink, isAuthorHost } from "../../adapters/aem-author.js";
import { aemAuthorLinks } from "../aem-author-links.js";
import { URL0, ctx, page } from "./helpers.js";

const links = (...hrefs: string[]) => hrefs.map((href) => ({ href, text: "", sameSite: false }));

describe("aem-author-links", () => {
  it("negative: ordinary links, and another site's editor path, pass", async () => {
    const p = page({
      links: links(
        "https://shop.example/rooms/garden",
        "https://shop.example/libs-of-the-trade",
        "https://shop.example/editor-picks",
        "https://www.other.example/editor.html",
        "mailto:hello@shop.example",
      ),
    });
    expect(await aemAuthorLinks.run(p, ctx)).toEqual([]);
  });

  it("positive: an author host on another domain is found by host", async () => {
    const found = await aemAuthorLinks.run(
      page({ links: links("https://author.other.example/content") }),
      ctx,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain("author.other.example/content");
  });

  it("negative: no links at all, and a plain page, give nothing", async () => {
    expect(await aemAuthorLinks.run(page(), ctx)).toEqual([]);
    expect(
      await aemAuthorLinks.run(page({ links: links("https://shop.example/menu") }), ctx),
    ).toEqual([]);
  });

  it("positive: an author host, the editor, the CRX, the libraries and the /ui#/aem app are each found, by host and path only", async () => {
    const p = page({
      links: links(
        "https://author-p12345-e67890.adobeaemcloud.com/ui#/aem/sites.html/content/hotel",
        "https://shop.example/editor.html/content/hotel/en/home.html?token=SECRET",
        "https://shop.example/crx/de/index.jsp",
        "https://shop.example/libs/granite/core/content/login.html",
        "https://shop.example/ui#/aem/assets.html",
        "https://author.shop.example/",
      ),
    });
    const found = await aemAuthorLinks.run(p, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "aem-author-links",
      severity: "medium",
      url: URL0,
    });
    expect(found[0]?.evidence).toMatch(/^6 links to the author tier: /);
    expect(found[0]?.evidence).not.toContain("SECRET");
    expect(found[0]?.evidence).not.toContain("?");
    expect(found[0]?.evidence).not.toContain("#");
  });

  it("the same link twice is one", async () => {
    const found = await aemAuthorLinks.run(
      page({ links: links("https://shop.example/crx/", "https://shop.example/crx/") }),
      ctx,
    );
    expect(found[0]?.evidence).toMatch(/^1 link to the author tier: /);
  });

  it("a malformed address never throws", async () => {
    expect(
      await aemAuthorLinks.run(page({ links: links("https://[bad", "//", "\uD800", "") }), ctx),
    ).toEqual([]);
  });
});

describe("author-tier address helpers", () => {
  it("knows the author hosts and nothing near them", () => {
    expect(isAuthorHost("author.shop.example")).toBe(true);
    expect(isAuthorHost("author-p1-e2.adobeaemcloud.com")).toBe(true);
    expect(isAuthorHost("AUTHOR-P1-E2.ADOBEAEMCLOUD.COM")).toBe(true);
    expect(isAuthorHost("author")).toBe(false);
    expect(isAuthorHost("authors.shop.example")).toBe(false);
    expect(isAuthorHost("publish-p1-e2.adobeaemcloud.com")).toBe(false);
    expect(isAuthorHost("author-p1-e2.adobeaemcloud.com.evil.example")).toBe(false);
    expect(isAuthorHost("author-pX-e2.adobeaemcloud.com")).toBe(false);
  });

  it("an editors' path counts on the page's own host only, and a lookalike path does not count", () => {
    expect(authorTierLink("https://a.example/editor.html/x", "a.example")).toBe("/editor.html");
    expect(authorTierLink("https://a.example/editor.html/x", "b.example")).toBeUndefined();
    expect(authorTierLink("https://a.example/editor.htmlx", "a.example")).toBeUndefined();
    expect(authorTierLink("https://a.example/crxy/", "a.example")).toBeUndefined();
    expect(authorTierLink("https://a.example/ui", "a.example")).toBeUndefined();
    expect(authorTierLink("https://a.example/ui#/other", "a.example")).toBeUndefined();
    expect(authorTierLink("https://a.example/UI#/AEM/x", "a.example")).toBe("/ui#/aem");
    expect(authorTierLink("ftp://author.a.example/", "a.example")).toBeUndefined();
  });

  it("a very long hostile address is answered in linear time", () => {
    const start = Date.now();
    authorTierLink(`https://${"author-p1-e2.".repeat(20000)}x.example/`, "a.example");
    authorTierLink(`https://a.example/${"/editor.html".repeat(50000)}`, "a.example");
    expect(Date.now() - start).toBeLessThan(500);
  });
});
