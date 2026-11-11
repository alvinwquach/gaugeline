import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { sitecoreFindings, sitecoreReads, SITECORE_SETTINGS } from "./sitecore-docs-example.js";
import { SITECORE_MARKERS } from "./sitecore-fixture.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/sitecore.md");
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

describe("docs/integrations/sitecore.md", () => {
  const built = BUILT_ADAPTERS.get("sitecore");

  it("opens with what the adapter reads and the narrowest key", () => {
    const headings = [...page.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings[0]).toBe("What this adapter reads, and the narrowest key");
    const top = page.split("## ")[1] ?? "";
    expect(top).toContain("The key first.");
    expect(top).toContain("`read-only`");
  });

  it("says when the documentation was checked, and marks the citation [docs]", () => {
    expect(page).toMatch(/Documentation checked on: \d{4}-\d{2}-\d{2}/);
    expect(page).toContain("[docs]");
  });

  it("has a freelancer example and a list of what could not be checked", () => {
    expect(page).toMatch(/^## Example: /m);
    expect(page).toMatch(/^## What cannot be checked$/m);
    expect(page).toMatch(/^## When it cannot check$/m);
  });

  it("the settings it shows are valid and are the ones the example reads with", () => {
    const shown = block("json", "gaugeline\\.adapters\\.json");
    expect(shown).toHaveLength(1);
    const parsed = adaptersConfigSchema.parse(JSON.parse(shown[0] ?? "null"));
    expect(parsed).toEqual({ adapters: [SITECORE_SETTINGS] });
  });

  it("the read it shows is what the adapter reads, and the findings are what the checks find", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toBe(await sitecoreReads());
    const findings = block("json", "Findings");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toBe(await sitecoreFindings());
  });

  it("says the token is read-only by nature, goes in sc_apikey and is sent to Edge only", () => {
    const top = page.split("## ")[1] ?? "";
    expect(top).toContain("read-only by nature");
    expect(top).toContain("`sc_apikey`");
    expect(top).toContain("edge.sitecorecloud.io");
  });

  it("names both checks, and says the probing one needs consent and a site you own", () => {
    expect(page).toContain("sitecore-route-no-page");
    expect(page).toContain("sitecore-preview-public");
    expect(page).toContain("--owner-consent");
    expect(page).toContain("expectPrivate");
    expect(page).toContain("Run it only on sites you own or have permission to test");
  });

  it("says plainly that the documentation pages were not read, and the entry is marked not verified", () => {
    expect(page).toContain("which means the pages were not read");
    expect(page).toContain("not verified");
  });

  it("every token or key in the page is a placeholder", () => {
    expect(page).not.toMatch(/sitecore_docs/);
  });

  it("shows no text from the site's content", () => {
    for (const marker of Object.values(SITECORE_MARKERS)) expect(page).not.toContain(marker);
  });

  it("is linked from the content systems page, as built, with the same name the registry has", () => {
    const row = rows(index, "Content system").find((r) => r[0] === built?.describe.name);
    expect(row?.[1]).toBe("built");
    expect(row?.[2]).toContain(built?.describe.keyKind ?? "?");
    expect(row?.[3]).toContain("/docs/integrations/sitecore");
  });
});
