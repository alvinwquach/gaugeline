import { describe, expect, it } from "vitest";
import { NAV, UNLISTED } from "../../docs/nav.js";
import { checkDocs, extractLinks } from "../lib/docs-check.js";

const base = {
  nav: [
    { group: "Getting started", slug: "quick-start" },
    { group: "The site check", slug: "options" },
  ],
  unlisted: [],
  files: ["quick-start", "options"],
  links: {},
};

describe("check-docs: unit", () => {
  it("a NAV slug with no file fails and names the slug", () => {
    expect(checkDocs({ ...base, files: ["quick-start"] })).toEqual([
      'NAV lists "options" (The site check) but docs/options.md does not exist.',
    ]);
  });

  it("a Markdown file not in NAV fails and names the file", () => {
    expect(checkDocs({ ...base, files: [...base.files, "stray"] })).toEqual([
      "docs/stray.md is not in NAV (or UNLISTED) in docs/nav.ts.",
    ]);
  });

  it("a link to /docs/optoins fails and names the page and the link", () => {
    const links = {
      "quick-start": extractLinks(
        "See [Options](/docs/optoins) and [ok](/docs/options?x=1#y).",
        "quick-start",
      ),
    };
    expect(checkDocs({ ...base, links })).toEqual([
      "docs/quick-start.md links to /docs/optoins, which does not exist.",
    ]);
  });

  it("a duplicate slug in two groups fails", () => {
    expect(
      checkDocs({ ...base, nav: [...base.nav, { group: "Reference", slug: "options" }] }),
    ).toEqual(['Slug "options" is in two groups: The site check and Reference.']);
  });

  it("extracts /docs/ links, relative .md links and href links, ignoring code blocks", () => {
    const md =
      '[a](/docs/ci) [b](options.md#x) [c](./faq.md) <a href="/docs/glossary">g</a>\n```\n[no](/docs/nowhere)\n```\n[gh](https://example.com/x.md)';
    expect(extractLinks(md, "quick-start").sort()).toEqual(["ci", "faq", "glossary", "options"]);
    expect(extractLinks("[up](../security.md)", "reference/json-schema")).toEqual(["security"]);
  });

  it("the real NAV has the six published groups in order, then Migrations, and every slug once", () => {
    expect(NAV.map((g) => g.group)).toEqual([
      "Getting started",
      "The site check",
      "Checks",
      "Sanity plugin",
      "Integrations",
      "Reference",
      "Migrations",
    ]);
    expect(NAV.filter((g) => g.soon).map((g) => g.group)).toEqual([
      "Sanity plugin",
      "Integrations",
    ]);
    const slugs = NAV.flatMap((g) => g.pages.map((p) => p.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(UNLISTED.every((u) => !slugs.includes(u.slug))).toBe(true);
  });
});
