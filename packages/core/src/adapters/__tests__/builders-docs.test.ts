import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILDERS, builderCannotRead } from "../builders.js";
import { adapterHeader } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { TIDEWATER_SETTINGS, tidewaterHint, tidewaterReads } from "./builders-docs-example.js";
import { TIDEWATER_MARKERS } from "./builders-fixture.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/builders.md");
const index = read("docs/integrations/index.md");

const block = (lang: string, title: string): string[] =>
  [
    ...page.matchAll(new RegExp("```" + lang + " title=" + title + "\\n([\\s\\S]*?)\\n```", "g")),
  ].map((m) => m[1] ?? "");

/** The text under a `### heading`, up to the next heading. */
function section(heading: string): string {
  const start = page.indexOf(`\n### ${heading}\n`);
  if (start < 0) return "";
  const rest = page.slice(start + 1);
  const next = rest.indexOf("\n#", 4);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("docs/integrations/builders.md", () => {
  it("the run header it shows is the line a run prints", () => {
    const squarespace = BUILT_ADAPTERS.get("squarespace");
    expect(squarespace).toBeDefined();
    const shown = block("text", "Output");
    expect(shown).toEqual([
      adapterHeader(squarespace?.describe ?? { name: "", docsUrl: "", keyKind: "read-only" }),
    ]);
  });

  it("the settings it shows are valid and are the ones the example reads with", () => {
    const shown = block("json", "gaugeline\\.adapters\\.json");
    expect(shown).toHaveLength(1);
    expect(adaptersConfigSchema.parse(JSON.parse(shown[0] ?? "null"))).toEqual({
      adapters: [TIDEWATER_SETTINGS],
    });
  });

  it("the output it shows for Tidewater Pop-Up is what the adapter reads", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toBe(await tidewaterReads());
  });

  it("the hint it shows is what suggestBuilder returns for the invented home page", () => {
    expect(block("json", "Hint")).toEqual([tidewaterHint()]);
  });

  it("shows no text from the site's pages", () => {
    for (const marker of Object.values(TIDEWATER_MARKERS)) expect(page).not.toContain(marker);
  });

  it("has a section for every platform with its id, its hints and its reason, word for word", () => {
    for (const b of BUILDERS) {
      const text = section(b.name);
      expect(text, b.name).not.toBe("");
      expect(text).toContain(`Adapter id: \`${b.id}\``);
      for (const host of b.hints.hosts) expect(text).toContain(`\`${host}\``);
      for (const g of b.hints.generator ?? []) expect(text).toContain(`\`${g}\``);
      expect(text).toContain(`Why no content read: ${b.apiNote}.`);
    }
  });

  it("each platform's run header links its own section, and the section's heading makes that anchor", () => {
    const slug = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    for (const b of BUILDERS) {
      expect(b.anchor).toBe(slug(b.name));
      expect(BUILT_ADAPTERS.get(b.id)?.describe.docsUrl).toBe(
        `https://gaugeline.dev/docs/integrations/builders#${b.anchor}`,
      );
    }
  });

  it("the reason in the example is the Squarespace reason the adapter gives", () => {
    const squarespace = BUILDERS.find((b) => b.id === "squarespace");
    expect(squarespace).toBeDefined();
    if (squarespace) expect(page).toContain(builderCannotRead(squarespace));
  });

  it("says plainly which content checks cannot run, and that detection is a hint", () => {
    for (const needle of ["draftsReachable", "fieldCounts", "fieldHashes", "members", "drift"])
      expect(page).toContain(needle);
    expect(page).toContain("**Detection is a hint.**");
    expect(page).toContain("uncited");
  });

  it("is linked from the content systems page: a built row for every platform, with the same name the registry has", () => {
    for (const b of BUILDERS) {
      const row = index
        .split("\n")
        .filter((l) => l.startsWith("|"))
        .map((l) => l.split("|").map((c) => c.trim()))
        .find((cells) => cells[1] === b.name);
      expect(row, b.name).toBeDefined();
      expect(row?.[2]).toBe("built");
      expect(row?.[3]).toContain("read-only");
      expect(row?.[4]).toContain(`/docs/integrations/builders#${b.anchor}`);
    }
  });
});
