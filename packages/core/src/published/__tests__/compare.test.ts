import { describe, expect, it } from "vitest";
import { hashValue } from "../../adapters/fingerprint.js";
import { buildSnapshot } from "../../snapshot.js";
import { differingFields, pageTexts, variantsOf } from "../compare.js";

const snap = (head: string, body = "") =>
  buildSnapshot([
    {
      url: "https://lantern-ladle.example/menu/autumn",
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);

const h = (v: string): string => hashValue(v) ?? "";

describe("comparing a field with a page: unit", () => {
  it("a page that shows the title in capitals still matches", () => {
    const s = snap("<title>AUTUMN COCKTAIL MENU</title>");
    expect(differingFields({ title: h("Autumn Cocktail Menu") }, ["title"], s)).toEqual([]);
    expect(differingFields({ title: h("Autumn cocktail menu") }, ["title"], s)).toEqual([]);
  });

  it("entities and typographic quotes in the page are the same title", () => {
    const s = snap("<title>Fish &amp; Chips Night &#8211; Tom&rsquo;s Special</title>");
    expect(
      differingFields({ title: h("Fish & Chips Night \u2013 Tom's Special") }, ["title"], s),
    ).toEqual([]);
    expect(
      differingFields({ title: h("Fish & Chips Night \u2013 Tom\u2019s Special") }, ["title"], s),
    ).toEqual([]);
  });

  it("a site name after the title is ignored, and the heading can show the title", () => {
    expect(
      differingFields(
        { title: h("Autumn menu") },
        ["title"],
        snap("<title>Autumn menu | Lantern & Ladle</title>"),
      ),
    ).toEqual([]);
    expect(
      differingFields(
        { title: h("Autumn menu") },
        ["title"],
        snap("<title>Welcome</title>", "<h1>Autumn menu</h1>"),
      ),
    ).toEqual([]);
  });

  it("names the field that differs, never its text", () => {
    const s = snap("<title>Summer menu</title>");
    const got = differingFields(
      { title: h("Autumn menu"), subtitle: h("Summer menu") },
      ["title", "subtitle"],
      s,
    );
    expect(got).toEqual(["title"]);
  });

  it("a field the item does not have is not compared", () => {
    expect(differingFields({}, ["title"], snap("<title>Anything</title>"))).toEqual([]);
  });

  it("page text is split around a site name, deduplicated and capped", () => {
    expect(pageTexts(snap("<title>Autumn menu \u2013 Lantern</title>"))).toEqual([
      "Autumn menu \u2013 Lantern",
      "Autumn menu",
      "Lantern",
    ]);
    expect(variantsOf("   ")).toEqual([]);
  });
});
