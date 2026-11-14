import { describe, expect, it } from "vitest";
import { filterProblem, modelConfigSchema, pathMatches } from "../config.js";

const parse = (value: unknown) => modelConfigSchema.safeParse(value);
const message = (value: unknown): string => {
  const r = parse(value);
  return r.success ? "" : `${r.error.issues[0]?.path.join(".")}: ${r.error.issues[0]?.message}`;
};

describe("gaugeline.model.json", () => {
  it("accepts the whole shape", () => {
    expect(
      parse({
        schema: "sanity/schema.json",
        previousSchema: "schema.before.json",
        retired: { article: ["subtitle"] },
        listings: [
          {
            name: "News",
            page: "/news",
            type: "article",
            filter: "!(archived == true)",
            item: "article.card",
            next: "a.older",
            slug: "slug.current",
          },
        ],
        dependents: [
          { page: "/", selector: "#insights li", type: "article", block: "Latest from the clinic" },
        ],
        idsShownOn: ["/dev/*"],
      }).success,
    ).toBe(true);
  });

  it("accepts an empty file: the page checks still run", () => {
    expect(parse({}).success).toBe(true);
  });

  it("says which field is wrong", () => {
    expect(message({ listings: [{ page: "news", type: "article", item: "li" }] })).toContain(
      "listings.0.page: must be one path",
    );
    expect(message({ listings: [{ page: "/news/*", type: "article", item: "li" }] })).toContain(
      "listings.0.page",
    );
    expect(message({ listings: [{ page: "/news", type: "bad type", item: "li" }] })).toContain(
      "document type name",
    );
    expect(message({ listings: [{ page: "/news", type: "a", item: "li[" }] })).toContain(
      "CSS selector",
    );
    expect(message({ retired: { article: [] } })).toContain("retired.article");
    expect(message({ retired: { article: ["two words"] } })).toContain("plain field name");
    expect(message({ nope: 1 })).toContain("nope");
  });

  it("caps the rules it reads", () => {
    const one = { page: "/", selector: "li", type: "a" };
    expect(parse({ dependents: Array.from({ length: 11 }, () => one) }).success).toBe(false);
  });
});

describe("a filter that narrows which documents a rule is about", () => {
  it("accepts plain GROQ conditions", () => {
    for (const f of [
      "!(archived == true)",
      'category->slug.current == "news"',
      "defined(summary) && count(tags[]) > 0",
      'title match "a)"',
    ])
      expect(filterProblem(f), f).toBeUndefined();
  });

  it("refuses what could close the bracket it is put in or open a projection", () => {
    expect(filterProblem("true] {title}[0")).toBeDefined();
    expect(filterProblem("true) || (1 == 1")).toBeDefined();
    expect(filterProblem("a == 1; b == 2")).toBeDefined();
    expect(filterProblem("a == {b: 1}")).toBeDefined();
    expect(filterProblem('a == "open')).toBeDefined();
    expect(filterProblem("(a == 1")).toBeDefined();
  });

  it("is checked when the file is read", () => {
    expect(
      message({
        dependents: [{ page: "/", selector: "li", type: "a", filter: "true] {title}[0" }],
      }),
    ).toContain("dependents.0.filter");
  });
});

describe("paths where an id is shown on purpose", () => {
  it("matches the page itself, and with a trailing * everything under it", () => {
    expect(pathMatches("/dev/*", "/dev/content-ids")).toBe(true);
    expect(pathMatches("/dev/*", "/dev")).toBe(true);
    expect(pathMatches("/dev/*", "/devices")).toBe(false);
    expect(pathMatches("/help/ids/", "/help/ids")).toBe(true);
    expect(pathMatches("/help/ids", "/help/ids/more")).toBe(false);
    expect(pathMatches("/*", "/anything/at/all")).toBe(true);
  });
});
