import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTENTFUL_CHECKS } from "../../checks/contentful.js";
import { adaptersConfigSchema } from "../config.js";
import { CONTENTFUL_CDA, CONTENTFUL_LIMITS, CONTENTFUL_PAGE_SIZE } from "../contentful.js";
import { CONTENTFUL_READ_LIMITS } from "../contentful-read.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { ASH_SETTINGS, ashFindings, ashReads } from "./contentful-docs-example.js";
import { CONTENTFUL_MARKERS } from "./contentful-fixture.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/contentful.md");
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

describe("docs/integrations/contentful.md", () => {
  const built = BUILT_ADAPTERS.get("contentful");

  it("opens with what the adapter reads and the narrowest key, and names the key and its kind", () => {
    const first = page.split("\n").find((l) => l.startsWith("## "));
    expect(first).toBe("## What this adapter reads, and the narrowest key");
    const top = page.split("## Make the token")[0] ?? "";
    expect(top).toContain("delivery token");
    expect(top).toContain("read-only");
    expect(top).toContain(`\`${built?.describe.keyKind}\``);
    expect(top).toContain(CONTENTFUL_CDA);
    // The key is sent in a header, and the address parameter form is refused.
    expect(top).toContain("`Authorization: Bearer`");
    expect(top).toContain("`access_token`");
  });

  it("is honest that the platform's own pages could not be read, and marks the citation [docs]", () => {
    expect(page).toContain("could not be reached");
    expect(page).toContain("[docs]");
    expect(page).toContain("uncited");
  });

  it("the settings it shows are valid and are the ones the example reads with", () => {
    const shown = block("json", "gaugeline\\.adapters\\.json");
    expect(shown).toHaveLength(1);
    expect(adaptersConfigSchema.parse(JSON.parse(shown[0] ?? "null"))).toEqual({
      adapters: [ASH_SETTINGS],
    });
  });

  it("the read it shows for Ash & Ember Taproom is what the adapter reads", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toBe(await ashReads());
  });

  it("the findings it shows are what the check finds", async () => {
    const found = block("json", "Findings");
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(await ashFindings());
  });

  it("shows no text from the site's content", () => {
    for (const marker of Object.values(CONTENTFUL_MARKERS)) expect(page).not.toContain(marker);
  });

  it("lists both endpoints the adapter uses, and the bounds it keeps", () => {
    for (const endpoint of [
      "GET /spaces/{space_id}/environments/{environment_id}/content_types",
      "GET /spaces/{space_id}/environments/{environment_id}/entries?content_type={id}&select=...",
    ])
      expect(rows(page, "Endpoint").some((r) => r[0] === `\`${endpoint}\``)).toBe(true);
    const n = (v: number) => v.toLocaleString("en-US");
    expect(rows(page, "Limit")).toEqual([
      ["Entries in one page of a list", n(CONTENTFUL_PAGE_SIZE)],
      ["Entries read from one content type", n(CONTENTFUL_LIMITS.entriesPerType)],
      ["Content types read from one space", n(CONTENTFUL_LIMITS.contentTypes)],
      ["Live pages asked for in one run", n(CONTENTFUL_READ_LIMITS.pages)],
    ]);
  });

  it("names the check, and the preview-token detection with its redaction promise", () => {
    expect(rows(page, "Check").map((r) => r[0])).toEqual(
      CONTENTFUL_CHECKS.map((c) => `\`${c.id}\``),
    );
    expect(rows(page, "Check").map((r) => r[1])).toEqual(CONTENTFUL_CHECKS.map((c) => c.severity));
    expect(page).toContain("`secret-in-js`");
    expect(page).toContain("no character of the token at all");
    expect(page).not.toContain("first 6 and the last 2 characters");
    expect(page).toContain(
      "never reported, by this detector or by the general `secret-assignment` one",
    );
  });

  it("its settings tables match the schema and the environment the adapter reads", () => {
    const fields = rows(page, "`gaugeline.adapters.json` field").map((r) => r[0] ?? "");
    expect(fields).toEqual(["`adapters[].id`", "`adapters[].fingerprint`", "`adapters[].urls`"]);
    expect(rows(page, "Environment variable").map((r) => r[0])).toEqual([
      "`CONTENTFUL_SPACE_ID`",
      "`CONTENTFUL_DELIVERY_TOKEN`",
      "`CONTENTFUL_ENVIRONMENT`",
      "`CONTENTFUL_PREVIEW_TOKEN`",
    ]);
  });

  it("is linked from the content systems page, as built, with the same name the registry has", () => {
    const row = rows(index, "Content system").find((r) => r[0] === built?.describe.name);
    expect(row?.[1]).toBe("built");
    expect(row?.[2]).toContain("read-only");
    expect(row?.[3]).toContain("/docs/integrations/contentful");
  });
});
