import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adapterHeader } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { FEED_PATHS, SITEMAP_FEED_LIMITS, SITEMAP_PATHS } from "../sitemap-feed.js";
import { OAKLINE_SETTINGS, oaklineReads } from "./sitemap-feed-docs-example.js";
import { OAKLINE_MARKERS } from "./sitemap-feed-fixture.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/sitemap-feed.md");
const index = read("docs/integrations/index.md");

const block = (lang: string, title: string): string[] =>
  [
    ...page.matchAll(new RegExp("```" + lang + " title=" + title + "\\n([\\s\\S]*?)\\n```", "g")),
  ].map((m) => m[1] ?? "");

/** The rows of the table that starts with this header cell: trimmed cells, header and rule left out. */
function rows(md: string, firstHeader: string): string[][] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`| ${firstHeader}`));
  const out: string[][] = [];
  for (let i = start + 2; i < lines.length && lines[i]?.startsWith("|"); i++)
    out.push(
      (lines[i] ?? "")
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  return out;
}

describe("docs/integrations/sitemap-feed.md", () => {
  const built = BUILT_ADAPTERS.get("sitemap-feed");

  it("the run header it shows is the line a run prints", () => {
    expect(built).toBeDefined();
    expect(block("text", "Output")).toEqual([
      adapterHeader(built?.describe ?? { name: "", docsUrl: "", keyKind: "read-only" }),
    ]);
  });

  it("the settings it shows are valid and are the ones the example reads with", () => {
    const shown = block("json", "gaugeline\\.adapters\\.json");
    expect(shown).toHaveLength(1);
    expect(adaptersConfigSchema.parse(JSON.parse(shown[0] ?? "null"))).toEqual({
      adapters: [OAKLINE_SETTINGS],
    });
  });

  it("the output it shows for Oakline Bakery is what the adapter reads", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toBe(await oaklineReads());
  });

  it("shows no text from the site's feed", () => {
    for (const marker of Object.values(OAKLINE_MARKERS)) expect(page).not.toContain(marker);
  });

  it("names every place it looks, and the limits it keeps", () => {
    for (const path of [...SITEMAP_PATHS, ...FEED_PATHS]) expect(page).toContain(`\`${path}\``);
    const limits = rows(page, "Limit");
    const n = (v: number) => v.toLocaleString("en-US");
    expect(limits).toEqual([
      ["Sitemap files read (index and children)", n(SITEMAP_FEED_LIMITS.sitemapFiles)],
      ["Feeds read", n(SITEMAP_FEED_LIMITS.feeds)],
      ["Addresses in all the files together", n(SITEMAP_FEED_LIMITS.entries)],
      ["One file, after gzip is unpacked", `${SITEMAP_FEED_LIMITS.fileBytes / (1024 * 1024)} MB`],
    ]);
  });

  it("says which questions need a native adapter: field counts, field hashes, drafts and members", () => {
    const table = rows(page, "Question").map((r) => r[0] ?? "");
    for (const needle of ["fieldCounts", "fieldHashes", "draftsReachable", "members"])
      expect(table.some((q) => q.includes(needle))).toBe(true);
  });

  it("its settings table matches the settings the schema takes", () => {
    const fields = rows(page, "`gaugeline.adapters.json` field").map((r) => r[0] ?? "");
    expect(fields).toEqual([
      "`adapters[].id`",
      "`adapters[].site`",
      "`adapters[].sitemaps`",
      "`adapters[].feeds`",
    ]);
  });

  it("is linked from the content systems page, as built, with the same name the registry has", () => {
    const row = rows(index, "Content system").find((r) => r[0] === built?.describe.name);
    expect(row?.[1]).toBe("built");
    expect(row?.[3]).toContain("/docs/integrations/sitemap-feed");
    expect(index).toContain("/docs/integrations/sitemap-feed#settings");
  });
});
