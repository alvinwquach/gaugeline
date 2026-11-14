import { describe, expect, it } from "vitest";
import { isThirdParty, siteKey } from "../third-party.js";

const PAGE = "https://shop.example/menu";

describe("siteKey: the registrable domain, or the whole host where there is none", () => {
  it("drops subdomains and www", () => {
    for (const url of [
      "https://shop.example/",
      "https://www.shop.example/a",
      "https://cdn.shop.example/x.js",
      "https://a.b.c.shop.example:8443/x.js",
      "HTTP://SHOP.EXAMPLE./x.js",
    ])
      expect(siteKey(url), url).toBe("shop.example");
  });

  it("keeps one more label under a multi-label public suffix", () => {
    expect(siteKey("https://www.site.co.uk/")).toBe("site.co.uk");
    expect(siteKey("https://cdn.site.co.uk/")).toBe("site.co.uk");
    expect(siteKey("https://shop.site.com.au/")).toBe("site.com.au");
  });

  it("treats each tenant of a hosting platform as its own site", () => {
    expect(siteKey("https://marlowe.vercel.app/")).toBe("marlowe.vercel.app");
    expect(siteKey("https://other.vercel.app/")).toBe("other.vercel.app");
  });

  it("uses the whole host for an address written as numbers and for a name with no dot", () => {
    expect(siteKey("http://127.0.0.1:4000/")).toBe("127.0.0.1");
    expect(siteKey("http://localhost:4000/")).toBe("localhost");
    expect(siteKey("http://[::1]:4000/")).toBe("::1");
  });

  it("is undefined for what is not a web address", () => {
    for (const url of [
      "not a url",
      "data:text/javascript,1",
      "blob:https://shop.example/x",
      "file:///a.js",
    ])
      expect(siteKey(url), url).toBeUndefined();
  });
});

describe("isThirdParty: a script from another site than the page's", () => {
  it("is false for the page's own site, its subdomains, other ports, schemes and a trailing dot", () => {
    for (const src of [
      "https://shop.example/app.js",
      "https://www.shop.example/app.js",
      "https://cdn.shop.example/app.js",
      "https://shop.example:8443/app.js",
      "http://shop.example/app.js",
      "https://shop.example./app.js",
    ])
      expect(isThirdParty(src, PAGE), src).toBe(false);
  });

  it("is true for another site, including one whose name ends the same way", () => {
    for (const src of [
      "https://cdn.widgets-example.test/chat.js",
      "https://evilshop.example/app.js",
      "https://shop.example.evil.test/app.js",
      "https://shop-example.test/app.js",
    ])
      expect(isThirdParty(src, PAGE), src).toBe(true);
  });

  it("does not take site.co.uk for evil.co.uk, nor the other way round", () => {
    expect(isThirdParty("https://evil.co.uk/a.js", "https://site.co.uk/")).toBe(true);
    expect(isThirdParty("https://site.co.uk/a.js", "https://evil.co.uk/")).toBe(true);
    expect(isThirdParty("https://cdn.site.co.uk/a.js", "https://www.site.co.uk/")).toBe(false);
  });

  it("does not take one tenant of a hosting platform for another", () => {
    expect(isThirdParty("https://other.vercel.app/a.js", "https://marlowe.vercel.app/")).toBe(true);
  });

  it("takes each tenant of a storage or hosting platform for its own site", () => {
    for (const platform of [
      "gitlab.io",
      "blogspot.com",
      "appspot.com",
      "supabase.co",
      "cloudfront.net",
      "s3.amazonaws.com",
    ]) {
      expect(siteKey(`https://shop.${platform}/`), platform).toBe(`shop.${platform}`);
      expect(
        isThirdParty(`https://other.${platform}/a.js`, `https://shop.${platform}/`),
        platform,
      ).toBe(true);
      expect(
        isThirdParty(`https://cdn.shop.${platform}/a.js`, `https://shop.${platform}/`),
        platform,
      ).toBe(false);
    }
  });

  it("is true when the page's own host and the script's are different loopback names", () => {
    expect(isThirdParty("http://localhost:5000/a.js", "http://127.0.0.1:4000/")).toBe(true);
    expect(isThirdParty("http://127.0.0.1:5000/a.js", "http://127.0.0.1:4000/")).toBe(false);
  });

  it("fails closed: an address that cannot be read, or is not a web address, is third-party", () => {
    for (const src of ["not a url", "data:text/javascript,1", "blob:https://shop.example/x", ""])
      expect(isThirdParty(src, PAGE), src).toBe(true);
    expect(isThirdParty("https://shop.example/a.js", "not a url")).toBe(true);
  });
});
