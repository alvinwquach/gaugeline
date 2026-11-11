import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { $CAMEL$Reads, $P$_SETTINGS } from "./$ID$-docs-example.js";
import { $P$_MARKERS } from "./$ID$-fixture.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/$ID$.md");
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

describe("docs/integrations/$ID$.md", () => {
  const built = BUILT_ADAPTERS.get("$ID$");

  it("opens with what the adapter reads and the narrowest key", () => {
    const headings = [...page.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings[0]).toBe("What this adapter reads, and the narrowest key");
    const top = page.split("## ")[1] ?? "";
    expect(top).toContain("The key first.");
    expect(top).toContain("`$KEYKIND$`");
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
    if (!TODO.test(shown[0] ?? "") && JSON.stringify(parsed) !== JSON.stringify({ adapters: [{ id: "$ID$" }] }))
      expect(parsed).toEqual({ adapters: [$P$_SETTINGS] });
  });

  it("the read it shows is what the adapter reads, once pasted", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toHaveLength(1);
    if (!TODO.test(outputs[0] ?? "")) expect(outputs[0]).toBe(await $CAMEL$Reads());
  });

  it("shows no text from the site's content", () => {
    for (const marker of Object.values($P$_MARKERS)) expect(page).not.toContain(marker);
  });

  it("is linked from the content systems page, as built, with the same name the registry has", () => {
    const row = rows(index, "Content system").find((r) => r[0] === built?.describe.name);
    expect(row?.[1]).toBe("built");
    expect(row?.[2]).toContain(built?.describe.keyKind ?? "?");
    expect(row?.[3]).toContain("/docs/integrations/$ID$");
  });
});
