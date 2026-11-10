/**
 * Integration tests over the built docs site. Run by the Docs workflow after `pnpm docs:build`:
 *   pnpm docs:build && pnpm vitest run --config vitest.docs.config.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMarkdownRenderer } from "vitepress";
import { describe, expect, it } from "vitest";
import { NAV } from "../nav.js";

const dist = fileURLToPath(new URL("../.vitepress/dist/", import.meta.url));
const lock = JSON.parse(
  readFileSync(fileURLToPath(new URL("../slugs.lock.json", import.meta.url)), "utf8"),
) as string[];

describe("docs build: integration", () => {
  it("vitepress build wrote one HTML file per NAV slug", () => {
    for (const g of NAV)
      for (const p of g.pages) expect(existsSync(`${dist}docs/${p.slug}.html`), p.slug).toBe(true);
  });

  it("every slug that was on the site before exists after the build (docs/slugs.lock.json)", () => {
    expect(lock.length).toBe(29);
    for (const slug of lock)
      expect(
        existsSync(`${dist}docs/${slug}.html`),
        `${slug} was renamed or removed: add a redirect`,
      ).toBe(true);
  });

  it("the six group names appear in the built sidebar in the stated order", () => {
    const html = readFileSync(`${dist}docs/quick-start.html`, "utf8");
    const at = [
      "Getting started",
      "The site check",
      "Checks",
      "Sanity plugin (soon)",
      "Integrations (soon)",
      "Reference",
    ].map((g) => html.indexOf(`>${g}<`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

describe("docs build: release requirements", () => {
  const html = (slug: string) => readFileSync(`${dist}docs/${slug}.html`, "utf8");
  const sinceLock = JSON.parse(
    readFileSync(fileURLToPath(new URL("../check-since.lock.json", import.meta.url)), "utf8"),
  ) as Record<string, string>;
  const checkIds = (
    JSON.parse(
      readFileSync(fileURLToPath(new URL("../checks.data.json", import.meta.url)), "utf8"),
    ) as { id: string }[]
  ).map((c) => c.id);

  it("the checks reference shows a Since badge on every check, with the released version where there is one", () => {
    const page = html("checks");
    const badges = [
      ...page.matchAll(/class="since" data-since="([^"]+)" data-released="(true|false)"/g),
    ];
    expect(badges).toHaveLength(checkIds.length);
    expect(page).toMatch(/id="noindex"[\s\S]*?data-since="0\.1\.0" data-released="true"/);
    const released = badges.filter((b) => b[2] === "true").length;
    expect(released).toBe(checkIds.filter((id) => sinceLock[id] !== undefined).length);
    // Everything else shows the next version, marked as not released.
    for (const b of badges.filter((b) => b[2] === "false")) expect(b[1]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("every page advertises the changelog feed and the feed is published at the site root", () => {
    expect(html("quick-start")).toMatch(
      /<link rel="alternate" type="application\/atom\+xml" title="Gaugeline changelog" href="\/changelog\.atom"/,
    );
    const feed = readFileSync(`${dist}changelog.atom`, "utf8");
    expect(feed.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(feed).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
  });

  it("the Node 22 guide is built, is in the sidebar, and the changelog links it", () => {
    expect(existsSync(`${dist}docs/migrations/node-22.html`)).toBe(true);
    expect(html("quick-start")).toContain(">Migrations<");
    expect(html("changelog")).toContain('href="/docs/migrations/node-22"');
    expect(html("changelog")).toContain('href="/changelog.atom"');
  });
});

describe("docs build: edge cases", () => {
  it("a table cell containing an escaped pipe renders as one cell", async () => {
    const md = await createMarkdownRenderer(fileURLToPath(new URL("..", import.meta.url)));
    const html = md.render("| Flag | Does |\n| --- | --- |\n| `a` | one \\| two |\n");
    expect(html.match(/<td>/g)).toHaveLength(2);
    expect(html).toContain("one | two");
  });

  it("a heading that appears twice on one page gets two different anchors", async () => {
    const md = await createMarkdownRenderer(fileURLToPath(new URL("..", import.meta.url)));
    const ids = [
      ...md.render("## Exit codes\n\ntext\n\n## Exit codes\n").matchAll(/id="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
