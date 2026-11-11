import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WEBFLOW_CHECKS } from "../../checks/webflow.js";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS } from "../registry.js";
import {
  WEBFLOW_API,
  WEBFLOW_LIMITS,
  WEBFLOW_PAGE_SIZE,
  WEBFLOW_STAGED_TOLERANCE_MS,
} from "../webflow.js";
import { WEBFLOW_READ_LIMITS } from "../webflow-read.js";
import { SALTMARSH_SETTINGS, saltmarshFindings, saltmarshReads } from "./webflow-docs-example.js";
import { WEBFLOW_MARKERS } from "./webflow-fixture.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/webflow.md");
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

describe("docs/integrations/webflow.md", () => {
  const built = BUILT_ADAPTERS.get("webflow");

  it("says in its first paragraphs that the key is a token with read scopes only, and names the scopes", () => {
    const top = page.split("## ")[0] ?? "";
    expect(top).toContain("only reads");
    expect(top).toContain("`sites:read`");
    expect(top).toContain("`cms:read`");
    expect(top).toContain(`\`${built?.describe.keyKind}\``);
  });

  it("is honest that the platform's own pages could not be read, and marks the citation [docs]", () => {
    expect(page).toContain("could not be reached");
    expect(page).toContain("[docs]");
  });

  it("the settings it shows are valid and are the ones the example reads with", () => {
    const shown = block("json", "gaugeline\\.adapters\\.json");
    expect(shown).toHaveLength(1);
    expect(adaptersConfigSchema.parse(JSON.parse(shown[0] ?? "null"))).toEqual({
      adapters: [SALTMARSH_SETTINGS],
    });
  });

  it("the read it shows for Saltmarsh Supper Club is what the adapter reads", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toBe(await saltmarshReads());
  });

  it("the findings it shows are what the two checks find", async () => {
    const found = block("json", "Findings");
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(await saltmarshFindings());
  });

  it("shows no text from the site's content", () => {
    for (const marker of Object.values(WEBFLOW_MARKERS)) expect(page).not.toContain(marker);
  });

  it("lists every endpoint the adapter uses, and the bounds it keeps", () => {
    expect(page).toContain(WEBFLOW_API);
    for (const endpoint of [
      "GET /v2/sites",
      "GET /v2/sites/{site_id}/collections",
      "GET /v2/collections/{collection_id}/items/live",
      "GET /v2/collections/{collection_id}/items",
    ])
      expect(rows(page, "Endpoint").some((r) => r[0] === `\`${endpoint}\``)).toBe(true);
    const n = (v: number) => v.toLocaleString("en-US");
    expect(rows(page, "Limit")).toEqual([
      ["Items in one page of a list", n(WEBFLOW_PAGE_SIZE)],
      ["Items read from one collection", n(WEBFLOW_LIMITS.itemsPerCollection)],
      ["Live pages asked for in one run", n(WEBFLOW_READ_LIMITS.pages)],
    ]);
  });

  it("states the tolerance the code keeps, and that the fetcher remembers answers", () => {
    expect(page).toContain(`more than ${WEBFLOW_STAGED_TOLERANCE_MS / 1000} seconds later`);
    expect(page).toContain("remembers every answer");
    expect(page).not.toContain("held in memory only while");
  });

  it("names both checks, in the order the registry has them", () => {
    const named = rows(page, "Check").map((r) => r[0]);
    expect(named).toEqual(WEBFLOW_CHECKS.map((c) => `\`${c.id}\``));
    const severities = rows(page, "Check").map((r) => r[1]);
    expect(severities).toEqual(WEBFLOW_CHECKS.map((c) => c.severity));
  });

  it("its settings table matches the settings the schema takes for this adapter", () => {
    const fields = rows(page, "`gaugeline.adapters.json` field").map((r) => r[0] ?? "");
    expect(fields).toEqual(["`adapters[].id`", "`adapters[].fingerprint`", "`adapters[].urls`"]);
  });

  it("is linked from the content systems page, as built, with the same name the registry has", () => {
    const row = rows(index, "Content system").find((r) => r[0] === built?.describe.name);
    expect(row?.[1]).toBe("built");
    expect(row?.[2]).toContain("read-only");
    expect(row?.[3]).toContain("/docs/integrations/webflow");
  });
});
