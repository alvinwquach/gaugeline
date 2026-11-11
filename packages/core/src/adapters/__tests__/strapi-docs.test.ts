import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STRAPI_CHECKS } from "../../checks/strapi.js";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { STRAPI_ENV_VARS, STRAPI_LIMITS, STRAPI_PAGE_SIZE } from "../strapi.js";
import { STRAPI_READ_LIMITS } from "../strapi-read.js";
import { BRASS_SETTINGS, brassFindings, brassReads } from "./strapi-docs-example.js";
import { STRAPI_MARKERS } from "./strapi-fixture.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/strapi.md");
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

describe("docs/integrations/strapi.md", () => {
  const built = BUILT_ADAPTERS.get("strapi");

  it("opens with what the adapter reads and the narrowest key, and says it only reads", () => {
    expect(page).toMatch(/^# .*\n\n## What this adapter reads, and the narrowest key\n/);
    const top = page.split("\n## What it reads")[0] ?? "";
    expect(top).toContain("Gaugeline only reads");
    expect(top).toContain("Read-only");
    expect(top).toContain(`\`${built?.describe.keyKind}\``);
    for (const v of STRAPI_ENV_VARS) expect(top).toContain(v);
  });

  it("is honest that the platform's own pages could not be reached, and marks the citation [docs]", () => {
    expect(page).toContain("could not be reached");
    expect(page).toContain("[docs]");
  });

  it("the settings it shows are valid and are the ones the example reads with", () => {
    const shown = block("json", "gaugeline\\.adapters\\.json");
    expect(shown).toHaveLength(1);
    expect(adaptersConfigSchema.parse(JSON.parse(shown[0] ?? "null"))).toEqual({
      adapters: [BRASS_SETTINGS],
    });
  });

  it("the read it shows for Brass Anchor Taproom is what the adapter reads", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toBe(await brassReads());
  });

  it("the findings it shows are what the two checks find", async () => {
    const found = block("json", "Findings");
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(await brassFindings());
  });

  it("shows no text from the site's content", () => {
    for (const marker of Object.values(STRAPI_MARKERS)) expect(page).not.toContain(marker);
  });

  it("lists every endpoint the adapter uses, and the bounds it keeps", () => {
    for (const endpoint of [
      "GET /api/{collection}",
      "GET /api/{collection}?status=draft",
      "GET /api/{collection}`, no token",
    ])
      expect(rows(page, "Endpoint").some((r) => (r[0] ?? "").startsWith(`\`${endpoint}`))).toBe(
        true,
      );
    const n = (v: number) => v.toLocaleString("en-US");
    expect(rows(page, "Limit")).toEqual([
      [
        "Entries in one page of a list (a smaller `api.rest.maxLimit` is followed)",
        n(STRAPI_PAGE_SIZE),
      ],
      ["Entries read from one collection", n(STRAPI_LIMITS.itemsPerType)],
      ["Ids read from each list by the draft check", n(STRAPI_LIMITS.publicIds)],
      ["Live pages asked for in one run", n(STRAPI_READ_LIMITS.pages)],
    ]);
  });

  it("says the draft check is a probing check, off without consent, and why", () => {
    expect(page).toContain("`strapi-drafts-public` is a probing check");
    expect(page).toContain("--owner-consent");
    expect(page).toContain("only on sites you own or have permission to test");
  });

  it("names both checks, in the order the registry has them", () => {
    const named = rows(page, "Check").map((r) => r[0]);
    expect(named).toEqual(STRAPI_CHECKS.map((c) => `\`${c.id}\``));
    expect(rows(page, "Check").map((r) => r[1])).toEqual(STRAPI_CHECKS.map((c) => c.severity));
  });

  it("its settings table matches the settings the schema takes for this adapter", () => {
    const fields = rows(page, "`gaugeline.adapters.json` field").map((r) => r[0] ?? "");
    expect(fields).toEqual(["`adapters[].id`", "`adapters[].fingerprint`", "`adapters[].urls`"]);
    expect(rows(page, "Environment variable").map((r) => r[0])).toEqual(
      STRAPI_ENV_VARS.map((v) => `\`${v}\``),
    );
  });

  it("is linked from the content systems page, as built, with the same name the registry has", () => {
    const row = rows(index, "Content system").find((r) => r[0] === built?.describe.name);
    expect(row?.[1]).toBe("built");
    expect(row?.[2]).toContain("read-only");
    expect(row?.[3]).toContain("/docs/integrations/strapi");
  });
});
