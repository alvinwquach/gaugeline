import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KONTENT_AI_CHECKS } from "../../checks/kontent-ai.js";
import { adaptersConfigSchema } from "../config.js";
import { KONTENT_ENV_VARS, KONTENT_LIMITS, KONTENT_PAGE_SIZE } from "../kontent-ai.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { KONTENT_SETTINGS, kontentFindings, kontentReads } from "./kontent-ai-docs-example.js";
import { KONTENT_MARKERS } from "./kontent-ai-fixture.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/kontent-ai.md");
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
  for (let i = start + 2; start >= 0 && i < lines.length && lines[i]?.startsWith("|"); i++)
    out.push(
      (lines[i] ?? "")
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  return out;
}

describe("docs/integrations/kontent-ai.md", () => {
  const built = BUILT_ADAPTERS.get("kontent-ai");

  it("opens with what the adapter reads and the narrowest key, and says it only reads", () => {
    const headings = [...page.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings[0]).toBe("What this adapter reads, and the narrowest key");
    const top = page.split("\n## What it reads")[0] ?? "";
    expect(top).toContain("Gaugeline only reads");
    expect(top).toContain("**The key first.**");
    expect(top).toContain(`\`${built?.describe.keyKind}\``);
    expect(top).toContain("secure access key");
    for (const v of KONTENT_ENV_VARS) expect(top + page).toContain(v);
  });

  it("says when the documentation was checked, that it could not be reached, and marks the citation [docs] and the rest uncited", () => {
    expect(page).toMatch(/Documentation checked on: \d{4}-\d{2}-\d{2}/);
    expect(page).toContain("could not be reached");
    expect(page).toContain("[docs]");
    expect(page).toContain("**uncited**");
  });

  it("has a freelancer example and a list of what could not be checked", () => {
    expect(page).toMatch(/^## Example: /m);
    expect(page).toMatch(/^## What cannot be checked$/m);
    expect(page).toMatch(/^## When it cannot check$/m);
  });

  it("the settings it shows are valid and are the ones the example reads with", () => {
    const shown = block("json", "gaugeline\\.adapters\\.json");
    expect(shown).toHaveLength(1);
    expect(adaptersConfigSchema.parse(JSON.parse(shown[0] ?? "null"))).toEqual({
      adapters: [KONTENT_SETTINGS],
    });
  });

  it("the read it shows for Fernhill Cycles is what the adapter reads", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toBe(await kontentReads());
  });

  it("the findings it shows are what the check find", async () => {
    const found = block("json", "Findings");
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(await kontentFindings());
  });

  it("shows no text from the site's content", () => {
    for (const marker of Object.values(KONTENT_MARKERS)) expect(page).not.toContain(marker);
  });

  it("lists every endpoint the adapter uses, and the bounds it keeps", () => {
    const endpoints = rows(page, "Endpoint").map((r) => r[0]);
    expect(endpoints).toEqual([
      "`GET https://deliver.kontent.ai/{environment id}/items`",
      "`GET https://preview-deliver.kontent.ai/{environment id}/items`",
    ]);
    const n = (v: number) => v.toLocaleString("en-US");
    expect(rows(page, "Limit")).toEqual([
      ["Items in one page of a list", n(KONTENT_PAGE_SIZE)],
      ["Items read from one list", n(KONTENT_LIMITS.items)],
      ["Pages of the live site asked in a run", n(KONTENT_LIMITS.pages)],
    ]);
  });

  it("says the preview check is a probing check, off without consent, and why", () => {
    expect(page).toContain("`kontent-ai-unpublished-live` is a probing check");
    expect(page).toContain("--owner-consent");
    expect(page).toContain("only on sites you own or have permission to test");
  });

  it("names the check, as the registry has it", () => {
    const named = rows(page, "Check").map((r) => r[0]);
    expect(named).toEqual(KONTENT_AI_CHECKS.map((c) => `\`${c.id}\``));
    expect(rows(page, "Check").map((r) => r[1])).toEqual(KONTENT_AI_CHECKS.map((c) => c.severity));
  });

  it("its settings tables match the settings the schema takes for this adapter", () => {
    const fields = rows(page, "`gaugeline.adapters.json` field").map((r) => r[0] ?? "");
    expect(fields).toEqual([
      "`adapters[].id`",
      "`adapters[].fingerprint`",
      "`adapters[].urls`",
      "`adapters[].slugElement`",
      "`adapters[].readPreview`",
    ]);
    expect(rows(page, "Environment variable").map((r) => r[0])).toEqual(
      KONTENT_ENV_VARS.map((v) => `\`${v}\``),
    );
  });

  it("is linked from the content systems page, as built, with the same name the registry has", () => {
    const row = rows(index, "Content system").find((r) => r[0] === built?.describe.name);
    expect(row?.[1]).toBe("built");
    expect(row?.[2]).toContain(built?.describe.keyKind ?? "?");
    expect(row?.[3]).toContain("/docs/integrations/kontent-ai");
  });
});
