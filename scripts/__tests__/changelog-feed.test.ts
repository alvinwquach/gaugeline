import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../../docs/.vitepress/config.js";
import { DEFAULT_DOCS_SITE, docsSiteUrl } from "../../docs/site.js";
import { escapeXml, renderAtom } from "../lib/atom.js";
import { renderChangelogPage, type ChangelogEntry } from "../lib/changelog.js";
import { listMigrations } from "../lib/migrations.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const SITE = "https://docs.example.test";
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8").replace(/\r\n/g, "\n");

/**
 * A strict well-formedness check, enough for a feed: one root, tags nest and close, attributes are
 * quoted, every & starts a known entity, no stray < or control characters.
 */
function assertWellFormed(xml: string): void {
  expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n')).toBe(true);
  // eslint-disable-next-line no-control-regex
  expect(xml).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  const token =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<&]*(?:&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);[^"<&]*)*")*)\s*(\/?)>|([^<]+)|(<)/g;
  const stack: string[] = [];
  let roots = 0;
  for (const m of xml.slice(xml.indexOf("?>") + 2).matchAll(token)) {
    if (m[6] !== undefined) throw new Error(`stray "<" near ${m.index}`);
    if (m[1] !== undefined) {
      expect(stack.pop(), `closing </${m[1]}>`).toBe(m[1]);
    } else if (m[2] !== undefined) {
      if (stack.length === 0) roots++;
      if (m[4] !== "/") stack.push(m[2]);
    } else if (m[5] !== undefined) {
      expect(m[5].replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, "")).not.toContain("&");
      if (stack.length === 0) expect(m[5].trim()).toBe("");
    }
  }
  expect(stack).toEqual([]);
  expect(roots).toBe(1);
}
const tags = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map(
    (m) => m[1] ?? "",
  );

const ENTRIES: ChangelogEntry[] = [
  {
    version: "0.3.0",
    date: "2026-12-01",
    headline: "Prices & shops",
    items: [
      "BREAKING: The old flag is gone. Migration: old-flag",
      "Reads <meta> tags once & keeps going.",
    ],
  },
  { version: "0.2.0", date: null, headline: null, items: ["Not shipped yet."] },
  { version: "0.1.5", date: "2026-11-02", headline: null, items: [] },
  { version: "0.1.1", date: "2026-09-23", headline: "Launches", items: ["Plan checks."] },
];

describe("changelog feed: unit", () => {
  it("escapeXml escapes the five characters and drops characters XML cannot hold", () => {
    expect(escapeXml(`a & b < c > d "e" 'f'`)).toBe(
      "a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;",
    );
    expect(escapeXml(`a${String.fromCharCode(0)}b${String.fromCharCode(11)}c`)).toBe("abc");
  });

  it("renders a well-formed Atom 1.0 feed with the required elements", () => {
    const xml = renderAtom(ENTRIES, { site: SITE });
    assertWellFormed(xml);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    const head = xml.slice(0, xml.indexOf("<entry>"));
    expect(head).toMatch(/<id>urn:gaugeline:changelog<\/id>/);
    expect(head).toMatch(/<title>[^<]+<\/title>/);
    expect(head).toMatch(/<updated>2026-12-01T00:00:00Z<\/updated>/);
    expect(head).toMatch(/<author><name>[^<]+<\/name><\/author>/);
    expect(head).toContain(
      `<link rel="self" type="application/atom+xml" href="${SITE}/changelog.atom"/>`,
    );
    expect(head).toContain(
      `<link rel="alternate" type="text/html" href="${SITE}/docs/changelog"/>`,
    );
  });

  it("has one entry per released version: undated and empty versions are left out", () => {
    const xml = renderAtom(ENTRIES, { site: SITE });
    expect(tags(xml, "entry")).toHaveLength(2);
    expect(xml).toContain("<id>urn:gaugeline:changelog:0.3.0</id>");
    expect(xml).toContain("<id>urn:gaugeline:changelog:0.1.1</id>");
    expect(xml).not.toContain("0.2.0");
    expect(xml).not.toContain("0.1.5");
  });

  it("every entry has id, title, updated and an absolute link; dates come from the changelog", () => {
    const xml = renderAtom(ENTRIES, { site: SITE });
    for (const entry of tags(xml, "entry")) {
      expect(entry).toMatch(/<id>urn:gaugeline:changelog:\d+\.\d+\.\d+<\/id>/);
      expect(entry).toMatch(/<title>[^<]+<\/title>/);
      expect(entry).toMatch(/<updated>\d{4}-\d{2}-\d{2}T00:00:00Z<\/updated>/);
      expect(entry).toMatch(
        /<link rel="alternate" type="text\/html" href="https:\/\/docs\.example\.test\/docs\/changelog#release-\d+-\d+-\d+"\/>/,
      );
    }
    expect(xml).toContain("<updated>2026-09-23T00:00:00Z</updated>");
  });

  it("entry ids do not depend on the site address; links do", () => {
    const a = renderAtom(ENTRIES, { site: SITE });
    const b = renderAtom(ENTRIES, { site: "https://elsewhere.example.test/" });
    const ids = (x: string) => tags(x, "id");
    expect(ids(a)).toEqual(ids(b));
    expect(b).toContain("https://elsewhere.example.test/docs/changelog#release-0-3-0");
    expect(b).not.toContain("elsewhere.example.test//");
  });

  it("the content keeps markup and special characters safe, and links the migration guide", () => {
    const xml = renderAtom(ENTRIES, { site: SITE });
    assertWellFormed(xml);
    const content = tags(xml, "content")[0] ?? "";
    expect(content).toContain("&lt;strong&gt;Breaking:&lt;/strong&gt; The old flag is gone.");
    expect(content).toContain(`href=&quot;${SITE}/docs/migrations/old-flag&quot;`);
    expect(content).toContain("Reads &amp;lt;meta&amp;gt; tags once &amp;amp; keeps going.");
    expect(xml).not.toContain("Migration: old-flag");
  });

  it("the same input gives the same bytes", () => {
    expect(renderAtom(ENTRIES, { site: SITE })).toBe(renderAtom(ENTRIES, { site: SITE }));
  });

  it("with nothing released the feed is still valid", () => {
    const xml = renderAtom([], { site: SITE });
    assertWellFormed(xml);
    expect(tags(xml, "entry")).toHaveLength(0);
    expect(tags(xml, "updated")).toHaveLength(1);
  });

  it("the changelog page links a migration guide, marks a breaking change and names the feed", () => {
    const page = renderChangelogPage(ENTRIES, {
      migrations: [{ slug: "old-flag", title: "The old flag is gone" }],
    });
    expect(page).toContain(
      "- **Breaking:** The old flag is gone. [Migration guide](/docs/migrations/old-flag)",
    );
    expect(page).toContain("## 0.3.0: Prices & shops {#release-0-3-0}");
    expect(page).toContain('<a href="/changelog.atom">Atom feed</a>');
    expect(page).toContain("- [The old flag is gone](/docs/migrations/old-flag)");
    expect(page).not.toContain("Migration: old-flag");
  });

  it("the docs site address: DOCS_URL wins, empty means the default, a non-web address is refused", () => {
    expect(docsSiteUrl({})).toBe(DEFAULT_DOCS_SITE);
    expect(docsSiteUrl({ DOCS_URL: "" })).toBe(DEFAULT_DOCS_SITE);
    expect(docsSiteUrl({ DOCS_URL: "https://docs.example.test/" })).toBe(
      "https://docs.example.test",
    );
    expect(() => docsSiteUrl({ DOCS_URL: "ftp://x.example.test" })).toThrow(/http/);
    expect(() => docsSiteUrl({ DOCS_URL: "not a url" })).toThrow();
  });
});

describe("changelog feed: the committed files", () => {
  const entries = JSON.parse(read("docs/changelog.data.json")) as ChangelogEntry[];
  const site = DEFAULT_DOCS_SITE;

  it("docs/public/changelog.atom is well-formed and is exactly what the generator renders", () => {
    const xml = read("docs/public/changelog.atom");
    assertWellFormed(xml);
    expect(xml).toBe(renderAtom(entries, { site }));
  });

  it("it has one entry for every released version in the docs changelog, each with an id and a date", () => {
    const xml = read("docs/public/changelog.atom");
    const released = entries.filter((e) => e.date !== null && e.items.length > 0);
    expect(released.length).toBeGreaterThan(0);
    expect(tags(xml, "entry")).toHaveLength(released.length);
    for (const e of released) {
      expect(xml).toContain(`<id>urn:gaugeline:changelog:${e.version}</id>`);
      expect(xml).toContain(`<updated>${e.date}T00:00:00Z</updated>`);
    }
    const ids = tags(xml, "id");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every link in the feed is absolute", () => {
    const xml = read("docs/public/changelog.atom");
    const hrefs = [...xml.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(hrefs.length).toBeGreaterThan(2);
    for (const h of hrefs) expect(h, h).toMatch(/^https?:\/\//);
    const inContent = [...xml.matchAll(/href=&quot;([^&]*)&quot;/g)].map((m) => m[1] ?? "");
    for (const h of inContent) expect(h, h).toMatch(/^https?:\/\//);
  });

  it("the docs head advertises the feed and the changelog page links to it and to every guide", () => {
    const links = (config.head ?? []).filter((h) => h[0] === "link");
    expect(links).toContainEqual([
      "link",
      expect.objectContaining({
        rel: "alternate",
        type: "application/atom+xml",
        href: "/changelog.atom",
      }),
    ]);
    const page = read("docs/changelog.md");
    expect(page).toContain('href="/changelog.atom"');
    for (const m of listMigrations(repoRoot))
      expect(page, m.slug).toContain(`(/docs/migrations/${m.slug})`);
  });
});

describe("changelog feed: the generator", () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(
      process.execPath,
      [
        join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
        join(repoRoot, "scripts/changelog-to-docs.ts"),
        ...args,
      ],
      { encoding: "utf8", cwd: repoRoot, env: { ...process.env, DOCS_URL: "", ...env } },
    );

  it("--check passes on the committed files", () => {
    const r = run(["--check"]);
    expect(r.status, r.stderr).toBe(0);
  }, 60_000);

  it("--check fails, naming the feed, when the configured docs address no longer matches it", () => {
    const r = run(["--check"], { DOCS_URL: "https://docs.example.test" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docs/public/changelog.atom");
    expect(r.stderr).not.toContain("docs/changelog.md,");
  }, 60_000);
});
