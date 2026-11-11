import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { HUBSPOT_CMS_LIMITS, HUBSPOT_CMS_PAGE_SIZE } from "../hubspot-cms.js";
import { HUBSPOT_READ_LIMITS } from "../hubspot-cms-read.js";
import {
  hubspotCmsFindings,
  hubspotCmsReads,
  HUBSPOT_CMS_SETTINGS,
} from "./hubspot-cms-docs-example.js";
import { HUBSPOT_CMS_MARKERS } from "./hubspot-cms-fixture.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/hubspot-cms.md");
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

describe("docs/integrations/hubspot-cms.md", () => {
  const built = BUILT_ADAPTERS.get("hubspot-cms");

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
    expect(parsed).toEqual({ adapters: [HUBSPOT_CMS_SETTINGS] });
  });

  it("the read it shows is what the adapter reads", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toBe(await hubspotCmsReads());
  });

  it("the findings it shows are what the three checks find", async () => {
    const found = block("json", "Findings");
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(await hubspotCmsFindings());
  });

  it("lists every endpoint the adapter uses, and the bounds it keeps", () => {
    for (const endpoint of [
      "GET /cms/v3/pages/site-pages",
      "GET /cms/v3/pages/landing-pages",
      "GET /cms/v3/blogs/posts",
      "GET /cms/v3/hubdb/tables",
      "GET /cms/v3/hubdb/tables/{table}/rows",
      "GET /account-info/v3/details",
      "GET /marketing/v3/forms/{formId}",
    ])
      expect(page).toContain(`\`${endpoint}\``);
    const bounds = rows(page, "Limit");
    const value = (name: string): string | undefined =>
      bounds.find((r) => r[0]?.startsWith(name))?.[1];
    expect(value("Items in one page")).toBe(String(HUBSPOT_CMS_PAGE_SIZE));
    expect(value("Items read from one list")).toBe(
      HUBSPOT_CMS_LIMITS.itemsPerType.toLocaleString("en-US"),
    );
    expect(value("Live pages")).toBe(String(HUBSPOT_READ_LIMITS.pages));
    expect(value("Different forms")).toBe(String(HUBSPOT_READ_LIMITS.forms));
    expect(value("Form embeds")).toBe(String(HUBSPOT_READ_LIMITS.formsPerPage));
  });

  it("is marked uncited where the platform's documentation could not be read", () => {
    expect(page).toContain("Documentation checked on: 2026-11-11");
    expect(page).toContain("`uncited`");
  });

  it("names every check, and none is a probing check", () => {
    for (const id of ["hubspot-page-404", "hubspot-hubdb-drift", "hubspot-form-deleted"])
      expect(page).toContain(`\`${id}\``);
    expect(page).toContain("None is a probing check");
  });

  it("has no unfinished text", () => {
    expect(TODO.test(page)).toBe(false);
  });

  it("shows no text from the site's content", () => {
    for (const marker of Object.values(HUBSPOT_CMS_MARKERS)) expect(page).not.toContain(marker);
  });

  it("is linked from the content systems page, as built, with the same name the registry has", () => {
    const row = rows(index, "Content system").find((r) => r[0] === built?.describe.name);
    expect(row?.[1]).toBe("built");
    expect(row?.[2]).toContain(built?.describe.keyKind ?? "?");
    expect(row?.[3]).toContain("/docs/integrations/hubspot-cms");
  });
});
