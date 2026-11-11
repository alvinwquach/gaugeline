import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { joomlaReads, JOOMLA_SETTINGS } from "./joomla-docs-example.js";
import { JOOMLA_MARKERS } from "./joomla-fixture.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/joomla.md");
const index = read("docs/integrations/index.md");

/** A marker for text still to be written. The scaffold has them; the no-TODO test refuses them at merge. */
const TODO = /TODO\(new:adapter\)/;

const block = (lang: string, title: string): string[] =>
  [
    ...page.matchAll(new RegExp("```" + lang + " title=" + title + "\\n([\\s\\S]*?)\\n```", "g")),
  ].map((m) => m[1] ?? "");

/** The rows of the table that starts with this header cell: trimmed cells, header and rule left out. */
function rows(md: string, firstHeader: string): string[][] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`| ${firstHeader}`));
  const out: string[][] = [];
  for (let i = start + 2; start >= 0 && i < lines.length && lines[i]?.startsWith("|"); i++)
    out.push(
      (lines[i] ?? "")
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  return out;
}

describe("docs/integrations/joomla.md", () => {
  const built = BUILT_ADAPTERS.get("joomla");

  it("opens with what the adapter reads and the narrowest key", () => {
    const headings = [...page.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings[0]).toBe("What this adapter reads, and the narrowest key");
    const top = page.split("## ")[1] ?? "";
    expect(top).toContain("The key first.");
    expect(top).toContain("`scoped`");
  });

  it("says when the documentation was checked, and marks the citation [docs]", () => {
    expect(page).toMatch(/Documentation checked on: (\d{4}-\d{2}-\d{2}|TODO\(new:adapter\))/);
    expect(page).toContain("[docs]");
  });

  it("has a freelancer example and a list of what could not be checked", () => {
    expect(page).toMatch(/^## Example: /m);
    expect(page).toMatch(/^## What cannot be checked$/m);
    expect(page).toMatch(/^## When it cannot check$/m);
  });

  it("the settings it shows are valid and are the ones the example reads with, once written", () => {
    const shown = block("json", "gaugeline\\.adapters\\.json");
    expect(shown).toHaveLength(1);
    const parsed = adaptersConfigSchema.parse(JSON.parse(shown[0] ?? "null"));
    if (
      !TODO.test(shown[0] ?? "") &&
      JSON.stringify(parsed) !== JSON.stringify({ adapters: [{ id: "joomla" }] })
    )
      expect(parsed).toEqual({ adapters: [JOOMLA_SETTINGS] });
  });

  it("the read it shows is what the adapter reads, once pasted", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toHaveLength(1);
    if (!TODO.test(outputs[0] ?? "")) expect(outputs[0]).toBe(await joomlaReads());
  });

  it("names both checks, and says the probing one needs consent and a site you own", () => {
    expect(page).toContain("joomla-article-no-page");
    expect(page).toContain("joomla-api-public");
    expect(page).toContain("--owner-consent");
    expect(page).toContain("only on sites you own or have permission to test");
  });

  it("says plainly that Joomla has no read-only token and that the docs sites were not reached", () => {
    expect(page).toContain("Joomla has no read-only token type");
    expect(page).toContain("could not be reached");
  });

  it("shows no text from the site's content", () => {
    for (const marker of Object.values(JOOMLA_MARKERS)) expect(page).not.toContain(marker);
  });

  it("is linked from the content systems page, as built, with the same name the registry has", () => {
    const row = rows(index, "Content system").find((r) => r[0] === built?.describe.name);
    expect(row?.[1]).toBe("built");
    expect(row?.[2]).toContain(built?.describe.keyKind ?? "?");
    expect(row?.[3]).toContain("/docs/integrations/joomla");
  });
});
