import { describe, expect, it } from "vitest";
import { resolvePage, type PageRules } from "../resolve.js";

const site = "https://lantern-yard.example";

// Three invented schema shapes: a page with a slug, a product under its category, a one-off page.
const pages: PageRules = {
  page: "/{slug}",
  product: "/shop/{category.slug}/{slug}",
  homePage: "/",
  event: (doc) => (typeof doc.slug === "string" ? `/whats-on/${doc.slug}` : null),
  siteSettings: null,
};

describe("resolvePage: three schema shapes", () => {
  it("a page with a slug renders at /slug", () => {
    expect(
      resolvePage({ _id: "p1", _type: "page", slug: { current: "menu" } }, { site, pages }),
    ).toEqual({
      kind: "page",
      url: "https://lantern-yard.example/menu",
    });
  });

  it("a product renders under its category, read from a slug object or plain text", () => {
    const doc = {
      _id: "drafts.p2",
      _type: "product",
      slug: { current: "negroni-kit" },
      category: { slug: { current: "cocktail-kits" } },
    };
    expect(resolvePage(doc, { site, pages })).toEqual({
      kind: "page",
      url: "https://lantern-yard.example/shop/cocktail-kits/negroni-kit",
    });
    expect(resolvePage({ ...doc, category: { slug: "gifts" } }, { site, pages })).toMatchObject({
      url: "https://lantern-yard.example/shop/gifts/negroni-kit",
    });
  });

  it("a one-off document and a function rule resolve", () => {
    expect(resolvePage({ _id: "home", _type: "homePage" }, { site, pages })).toMatchObject({
      url: "https://lantern-yard.example/",
    });
    expect(
      resolvePage({ _id: "e", _type: "event", slug: "quiz-night" }, { site, pages }),
    ).toMatchObject({
      url: "https://lantern-yard.example/whats-on/quiz-night",
    });
  });
});

describe("resolvePage: documents that are not pages, and ones that cannot be resolved", () => {
  it("a document whose rule is null, or whose type has no rule, renders to no page", () => {
    expect(resolvePage({ _id: "s", _type: "siteSettings" }, { site, pages })).toMatchObject({
      kind: "no-page",
    });
    expect(resolvePage({ _id: "x", _type: "menuSection" }, { site, pages })).toMatchObject({
      kind: "no-page",
    });
  });

  it("a function that returns nothing means no page", () => {
    expect(resolvePage({ _id: "e", _type: "event" }, { site, pages })).toMatchObject({
      kind: "no-page",
    });
  });

  it("a missing slug, or a reference that was not expanded, is unresolved and says which field", () => {
    expect(resolvePage({ _id: "p", _type: "page" }, { site, pages })).toMatchObject({
      kind: "unresolved",
      reason: expect.stringContaining("slug"),
    });
    const unexpanded = { _id: "p", _type: "product", slug: "a", category: { _ref: "cat-1" } };
    expect(resolvePage(unexpanded, { site, pages })).toMatchObject({
      kind: "unresolved",
      reason: expect.stringContaining("category.slug"),
    });
  });

  it("slugs are data: anything that could leave the path is refused", () => {
    for (const slug of [
      "../admin",
      "a/../../b",
      "//evil.example",
      "a b",
      "a?x=1",
      "a#b",
      "",
      "%2e%2e",
      "\\x",
    ]) {
      expect(resolvePage({ _id: "p", _type: "page", slug }, { site, pages }).kind, slug).toBe(
        "unresolved",
      );
    }
  });

  it("a rule can never send the check to another site", () => {
    const rules: PageRules = {
      a: () => "https://evil.example/x",
      b: () => "//evil.example/x",
      c: () => `${site}/ok`,
      d: () => "javascript:alert(1)",
    };
    const kinds = ["a", "b", "c", "d"].map(
      (t) => resolvePage({ _id: t, _type: t }, { site, pages: rules }).kind,
    );
    expect(kinds).toEqual(["unresolved", "unresolved", "page", "unresolved"]);
  });

  it("a site that is not an http(s) address is refused at once", () => {
    expect(() =>
      resolvePage({ _id: "p", _type: "page", slug: "a" }, { site: "ftp://x.example", pages }),
    ).toThrow(/site/);
  });
});

describe("resolvePage: names that are not rules", () => {
  it("a type called constructor, __proto__ or toString is not taken from the object's prototype", () => {
    for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(resolvePage({ _id: "x", _type: type, slug: "a" }, { site, pages }).kind, type).toBe(
        "no-page",
      );
    }
  });

  it("a function-rule address with a user name or password is refused", () => {
    const rules: PageRules = {
      a: () => "https://user:secret@lantern-yard.example/x",
      b: () => "https://user@lantern-yard.example/x",
    };
    for (const t of ["a", "b"]) {
      const r = resolvePage({ _id: t, _type: t }, { site, pages: rules });
      expect(r.kind).toBe("unresolved");
      expect(JSON.stringify(r)).not.toContain("secret");
    }
  });

  it("a slug of 512 characters is allowed and one of 513 is refused", () => {
    const ok = "a".repeat(512);
    expect(resolvePage({ _id: "p", _type: "page", slug: ok }, { site, pages }).kind).toBe("page");
    expect(resolvePage({ _id: "p", _type: "page", slug: `${ok}a` }, { site, pages }).kind).toBe(
      "unresolved",
    );
  });
});
