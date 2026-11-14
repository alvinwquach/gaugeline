/**
 * The one place a link to the docs is built (docs-url.ts): only a check that has a page in this repository gets a
 * link, the page is a file that exists, the base is one constant, and the module is not part of the package's
 * public surface.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECKS_DOCS_BASE, CHECK_PAGES, checkDocsUrl } from "../docs-url.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const ids = (
  JSON.parse(readFileSync(join(root, "docs/checks.data.json"), "utf8")) as Array<{ id: string }>
).map((c) => c.id);

describe("checkDocsUrl", () => {
  it("links a check that has a page under docs/checks, by that page's file", () => {
    expect(checkDocsUrl("cms-token-in-client-code")).toBe(`${CHECKS_DOCS_BASE}tokens-in-source.md`);
    expect(Object.keys(CHECK_PAGES).length).toBeGreaterThan(10);
  });

  it("gives nothing for a check with no page, a made-up id, or anything that is not an id", () => {
    for (const id of [
      "menu-link-broken",
      "nope",
      "",
      "__proto__",
      "constructor",
      "toString",
      "../x",
      "a b",
      "tokens-in-source/../x",
    ])
      expect(checkDocsUrl(id), id).toBeUndefined();
  });

  it("every linked page is a file in the repository whose table names that check, and the check exists", () => {
    for (const [id, page] of Object.entries(CHECK_PAGES)) {
      const file = join(root, "docs/checks", `${page}.md`);
      expect(existsSync(file), `${id} -> ${page}`).toBe(true);
      expect(readFileSync(file, "utf8"), `${id} in ${page}`).toMatch(
        new RegExp(`^\\| \`${id}\`\\s*\\|`, "m"),
      );
      expect(ids, id).toContain(id);
      expect(checkDocsUrl(id)).toMatch(
        /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/main\/docs\/checks\/[a-z-]+\.md$/,
      );
    }
  });

  it("every page under docs/checks is used, so a new page cannot sit unlinked unnoticed", () => {
    const pages = readdirSync(join(root, "docs/checks"))
      .filter((n) => n.endsWith(".md"))
      .map((n) => n.slice(0, -3));
    expect([...new Set(Object.values(CHECK_PAGES))].sort()).toEqual(pages.sort());
  });
});

describe("the module is internal", () => {
  it("is not exported from the package index, so the public surface does not change", () => {
    const index = readFileSync(join(root, "packages/core/src/index.ts"), "utf8");
    expect(index).not.toMatch(/docs-url/);
    expect(index).not.toMatch(/checkDocsUrl|CHECKS_DOCS_BASE|CHECK_PAGES/);
  });

  it("names no domain of its own", () => {
    const text = readFileSync(join(root, "packages/core/src/docs-url.ts"), "utf8");
    expect(text).not.toMatch(/gaugeline\.(dev|io|com|app)/);
    expect([...text.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => new URL(m[0]).host)).toEqual([
      "github.com",
    ]);
  });
});
