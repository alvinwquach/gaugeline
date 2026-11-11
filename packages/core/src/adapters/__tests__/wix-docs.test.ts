import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adapterHeader } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { WIX_CMS_READ_PATH, WIX_QUERY_ALLOW } from "../wix.js";
import {
  marlowNativeReads,
  marlowReads,
  MARLOW_NATIVE_SETTINGS,
  MARLOW_SETTINGS,
} from "./wix-docs-example.js";
import { MARLOW_MARKERS } from "./wix-fixture.js";
import { WIX_NATIVE_MARKERS } from "./wix-native-fixture.js";

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
    expect(shown[0]).toContain("Content system: Wix, with a read-only key when one is set");
  });

  it("the settings it shows are valid and are the ones the examples read with", () => {
    const shown = block("json", "gaugeline\\.adapters\\.json");
    expect(shown).toHaveLength(2);
    // The first is the example with the key, the second the live-site read with none.
    expect(adaptersConfigSchema.parse(JSON.parse(shown[0] ?? "null"))).toEqual({
      adapters: [MARLOW_NATIVE_SETTINGS],
    });
    expect(adaptersConfigSchema.parse(JSON.parse(shown[1] ?? "null"))).toEqual({
      adapters: [MARLOW_SETTINGS],
    });
  });

  it("the output it shows for Marlow Coaching is what the adapter reads, with the key and without", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toBe(await marlowNativeReads());
    expect(outputs[1]).toBe(await marlowReads());
  });

  it("the key is in the environment in the example, never in a settings block, and the page holds no key", () => {
    for (const settings of block("json", "gaugeline\\.adapters\\.json"))
      expect(settings).not.toMatch(/key/i);
    expect(page).toContain("WIX_API_KEY=<");
    expect(page).not.toMatch(/IST\.|wix_docs_/);
  });

  it("shows no text from the site's pages", () => {
    for (const marker of [...Object.values(MARLOW_MARKERS), ...Object.values(WIX_NATIVE_MARKERS)])
      expect(page).not.toContain(marker);
  });

  it("states the key's access level and the one POST, near the top", () => {
    const firstParagraphs = page.split("\n").slice(0, 10).join("\n");
    expect(firstParagraphs).toContain("no key");
    expect(firstParagraphs).toContain("API key with only read permissions");
    expect(firstParagraphs).toContain("POST");
    expect(firstParagraphs).toContain("ADR-0006");
    expect(page).toContain("What this adapter reads, and the narrowest key");
    expect(page).toContain(`${WIX_CMS_READ_PATH.path}`);
    expect(page).toContain(WIX_QUERY_ALLOW.id);
    expect(page).toContain(WIX_QUERY_ALLOW.host as string);
    expect(page).toContain("open question 52");
  });

  it("says a Wix Data query returns every item the key can read, not only published ones", () => {
    const reads = (built?.docs?.reads ?? "").split("With the key:")[1] ?? "";
    expect(reads).not.toMatch(/published items/i);
    expect(index).not.toMatch(/field counts and published items/);
    expect(page).not.toMatch(/published items/i);
    expect(page).toContain("every item the key can read");
  });

  it("says Gaugeline cannot check that a key is read-only, and that making one is the owner's job", () => {
    expect(page).toMatch(/cannot (see|check) (what|whether)[^.]*key/i);
    expect(page).toContain("you make");
  });

  it("is marked beta, with the reason: the endpoint shapes are not confirmed", () => {
    expect(built?.describe.beta).toBe(true);
    expect(page.split("\n")[0]).toContain("(beta)");
    expect(page).toContain("This adapter is beta");
    expect(page).toContain("Content system: Wix (beta)");
  });

  it("states the limits on ids, slugs, field names and the site id, and that the CMS read is skipped without a site id or a collection", () => {
    expect(page).toContain("## Limits on names and ids");
    for (const needle of ["128", "letters, digits", "siteId", "120 seconds", "one leading"])
      expect(page).toContain(needle);
    expect(page).toContain("WIX_API_KEY is set but");
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
      "`adapters[].siteId`",
      "`adapters[].urls`",
      "`adapters[].fingerprint`",
      "`adapters[].site`",
      "`adapters[].sitemaps`",
      "`adapters[].feeds`",
    ]);
  });

  it("is linked from the content systems page, as built, with the same name the registry has", () => {
    const row = rows(index, "Content system").find((r) => r[0] === built?.describe.name);
    expect(row?.[1]).toBe("built");
    expect(row?.[2]).toContain("none to read the live site");
    expect(row?.[2]).toContain("read-only");
    expect(row?.[3]).toContain("wix.md");
  });
});
