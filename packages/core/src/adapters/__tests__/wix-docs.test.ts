import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adapterHeader } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { WIX_CMS_READ_PATH } from "../wix.js";
import { marlowReads, MARLOW_SETTINGS } from "./wix-docs-example.js";
import { MARLOW_MARKERS } from "./wix-fixture.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/wix.md");
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

describe("docs/integrations/wix.md", () => {
  const built = BUILT_ADAPTERS.get("wix");

  it("the run header it shows is the line a run prints", () => {
    expect(built).toBeDefined();
    const shown = block("text", "Output");
    expect(shown).toEqual([
      adapterHeader(built?.describe ?? { name: "", docsUrl: "", keyKind: "read-only" }),
    ]);
    expect(shown[0]).toContain("Content system: Wix, with no key");
  });

  it("the settings it shows are valid and are the ones the example reads with", () => {
    const shown = block("json", "gaugeline\\.adapters\\.json");
    expect(shown).toHaveLength(1);
    expect(adaptersConfigSchema.parse(JSON.parse(shown[0] ?? "null"))).toEqual({
      adapters: [MARLOW_SETTINGS],
    });
  });

  it("the output it shows for Marlow Coaching is what the adapter reads", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toBe(await marlowReads());
  });

  it("shows no text from the site's pages", () => {
    for (const marker of Object.values(MARLOW_MARKERS)) expect(page).not.toContain(marker);
  });

  it("states the key's access level and why the CMS is not read, near the top", () => {
    const firstParagraphs = page.split("\n").slice(0, 10).join("\n");
    expect(firstParagraphs).toContain("no key");
    expect(firstParagraphs).toContain("API key with only read permissions");
    expect(firstParagraphs).toContain("POST");
    expect(page).toContain(`${WIX_CMS_READ_PATH.method} ${WIX_CMS_READ_PATH.path}`);
    expect(page).toContain("open question 52");
  });

  it("marks what it could not confirm: the sources note and the uncited endpoint shapes", () => {
    expect(page).toContain("could not be reached");
    expect(page).toContain("[docs]");
    expect(page).toContain("uncited");
  });

  it("names the questions it cannot answer: fieldCounts, fieldHashes, draftsReachable, members and hidden items", () => {
    const table = rows(page, "Question").map((r) => r[0] ?? "");
    for (const needle of ["fieldCounts", "fieldHashes", "draftsReachable", "members", "hidden"])
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
    expect(row?.[2]).toContain("no key");
    expect(row?.[3]).toContain("wix.md");
  });
});
