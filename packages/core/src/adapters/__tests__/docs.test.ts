import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adapterHeader } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS, PLANNED_ADAPTERS } from "../registry.js";
import { KEY_KINDS } from "../types.js";
import { FERNHILL_SETTINGS, fernhillReads } from "./docs-example.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/index.md");

/** The rows of the first table: its cells, trimmed, with the header and the rule left out. */
function tableRows(md: string, firstHeader: string): string[][] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`| ${firstHeader}`));
  const rows: string[][] = [];
  for (let i = start + 2; i < lines.length && lines[i]?.startsWith("|"); i++)
    rows.push(
      (lines[i] ?? "")
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  return rows;
}

const block = (title: string): string | undefined =>
  new RegExp("```(?:text|json) title=" + title + "\\n([\\s\\S]*?)\\n```").exec(page)?.[1];

describe("docs/integrations/index.md: the table of content systems", () => {
  const rows = tableRows(page, "Content system");

  it("every built adapter has a row that says built and names its key kind", () => {
    for (const built of BUILT_ADAPTERS.values()) {
      const row = rows.find((r) => r[0] === built.describe.name);
      expect(row, built.describe.name).toBeDefined();
      expect(row?.[1]).toBe("built");
      expect(row?.[2]).toContain(built.describe.keyKind);
    }
  });

  it("every row that says built is an adapter that exists", () => {
    const names = new Set([...BUILT_ADAPTERS.values()].map((b) => b.describe.name));
    for (const r of rows.filter((r) => r[1] === "built")) expect(names.has(r[0] ?? "")).toBe(true);
  });

  it("every planned adapter has a planned row with its branch id, and no row is planned twice", () => {
    for (const p of PLANNED_ADAPTERS) {
      const row = rows.find((r) => r[0] === p.name);
      expect(row, p.name).toBeDefined();
      expect(row?.[1]).toBe(`planned (${p.branch})`);
    }
    const planned = rows.filter((r) => r[1]?.startsWith("planned"));
    expect(planned).toHaveLength(PLANNED_ADAPTERS.length);
    expect(rows).toHaveLength(BUILT_ADAPTERS.size + PLANNED_ADAPTERS.length);
  });

  it("a planned row never claims a key kind it has not confirmed", () => {
    for (const r of rows.filter((r) => r[1]?.startsWith("planned")))
      for (const kind of KEY_KINDS) expect(r[2]).not.toContain(kind);
  });
});

describe("docs/integrations/index.md: the key and the example", () => {
  it("explains all three key kinds", () => {
    const kinds = tableRows(page, "Key kind").map((r) => r[0]);
    expect(kinds).toEqual(KEY_KINDS.map((k) => `\`${k}\``));
  });

  it("the run header it shows is the line the run prints", () => {
    const built = BUILT_ADAPTERS.get("sanity");
    expect(built).toBeDefined();
    expect(block("Output")).toBe(
      adapterHeader(built?.describe ?? { name: "", docsUrl: "", keyKind: "read-only" }),
    );
  });

  it("the settings file it shows is valid and is the one the example reads with", () => {
    const shown = /```json title=gaugeline\.adapters\.json\n([\s\S]*?)\n```/.exec(page)?.[1];
    const parsed = adaptersConfigSchema.parse(JSON.parse(shown ?? "null"));
    expect(parsed).toEqual({ adapters: [FERNHILL_SETTINGS] });
  });

  it("the output it shows for Fernhill Coaching is what the adapter reads", async () => {
    const blocks = [...page.matchAll(/```json title=Output\n([\s\S]*?)\n```/g)].map((m) => m[1]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toBe(await fernhillReads());
  });

  it("shows no text from the dataset's content", async () => {
    expect(page).not.toContain("Spring cohort now open");
    expect(page).not.toContain("Finding your next step with a coach");
  });
});

describe("CONTRIBUTING.md: writing an adapter", () => {
  const contributing = read("CONTRIBUTING.md");

  it("has the section the docs page links to, naming the contract suite and the three places a new adapter goes", () => {
    expect(contributing).toContain("## Writing an adapter");
    for (const place of ["registry.ts", "entries.ts", "docs/integrations/index.md"])
      expect(contributing).toContain(place);
  });
});
