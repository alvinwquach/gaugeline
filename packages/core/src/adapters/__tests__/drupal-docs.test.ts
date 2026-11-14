import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DRUPAL_CHECKS } from "../../checks/drupal.js";
import { adaptersConfigSchema } from "../config.js";
import { DRUPAL_ENV_VARS, DRUPAL_LIMITS, DRUPAL_PAGE_SIZE } from "../drupal.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { DRUPAL_SETTINGS, drupalFindings, drupalReads } from "./drupal-docs-example.js";
import { DRUPAL_MARKERS } from "./drupal-fixture.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/drupal.md");
const index = read("docs/integrations/index.md");
const options = read("docs/options.md");

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

describe("docs/integrations/drupal.md", () => {
  const built = BUILT_ADAPTERS.get("drupal");

  it("opens with what the adapter reads and the narrowest key, and says it only reads", () => {
    const headings = [...page.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings[0]).toBe("What this adapter reads, and the narrowest key");
    const top = page.split("\n## What it reads")[0] ?? "";
    expect(top).toContain("Gaugeline only reads");
    expect(top).toContain("**The key first.**");
    expect(top).toContain(`\`${built?.describe.keyKind}\``);
    expect(top).toContain("no key");
    expect(top).toContain("optional");
    expect(built?.describe.optionalKey).toBe(true);
    for (const v of DRUPAL_ENV_VARS) expect(page).toContain(v);
  });

  it("says plainly that core has no view-only permission for unpublished nodes", () => {
    expect(page).toContain(
      "Drupal core has no permission that lets a role view other people's unpublished nodes",
    );
    expect(page).toContain("`bypass node access`");
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
      adapters: [DRUPAL_SETTINGS],
    });
  });

  it("the read it shows for Fernlea Family Clinic is what the adapter reads", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toBe(await drupalReads());
  });

  it("the findings it shows are what the check finds", async () => {
    const found = block("json", "Findings");
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(await drupalFindings());
  });

  it("shows no text from the site's content", () => {
    for (const marker of Object.values(DRUPAL_MARKERS)) expect(page).not.toContain(marker);
  });

  it("lists every endpoint the adapter uses, and the bounds it keeps", () => {
    expect(rows(page, "Endpoint").map((r) => r[0])).toEqual([
      "`GET /jsonapi/ENTITY/BUNDLE`",
      "`GET /jsonapi/node/BUNDLE`, unpublished",
      "`GET /node/NID`, no credential",
    ]);
    const n = (v: number) => v.toLocaleString("en-US");
    expect(rows(page, "Limit")).toEqual([
      ["Resources in one page of a list", n(DRUPAL_PAGE_SIZE)],
      ["Resources read from one type", n(DRUPAL_LIMITS.itemsPerType)],
      ["Unpublished nodes listed for one type", n(DRUPAL_LIMITS.unpublishedPerType)],
      ["Node pages asked for in one run", n(DRUPAL_LIMITS.pages)],
    ]);
  });

  it("says the check is a probing check, off without consent and the settings entry, and why", () => {
    expect(page).toContain("`drupal-unpublished-reachable` is a probing check");
    expect(page).toContain("--owner-consent");
    expect(page).toContain('`"readUnpublished": true`');
    expect(page).toContain("only on sites you own or have permission to test");
  });

  it("names the check, and the probing-check sentence in the options page names it too", () => {
    expect(rows(page, "Check").map((r) => r[0])).toEqual(DRUPAL_CHECKS.map((c) => `\`${c.id}\``));
    expect(rows(page, "Check").map((r) => r[1])).toEqual(DRUPAL_CHECKS.map((c) => c.severity));
    expect(options).toContain(
      "`drupal-unpublished-reachable`, described in [Drupal](integrations/drupal.md#the-check)",
    );
  });

  it("its settings tables match the settings the schema takes for this adapter", () => {
    expect(rows(page, "`gaugeline.adapters.json` field").map((r) => r[0])).toEqual([
      "`adapters[].id`",
      "`adapters[].fingerprint`",
      "`adapters[].urls`",
      "`adapters[].readUnpublished`",
    ]);
    expect(rows(page, "Environment variable").map((r) => r[0])).toEqual(
      DRUPAL_ENV_VARS.map((v) => `\`${v}\``),
    );
  });

  it("is linked from the content systems page, as built, with the same name the registry has", () => {
    const row = rows(index, "Content system").find((r) => r[0] === built?.describe.name);
    expect(row?.[1]).toBe("built");
    expect(row?.[2]).toContain(built?.describe.keyKind ?? "?");
    expect(row?.[3]).toContain("/docs/integrations/drupal");
  });
});
