import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adapterHeader } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS, PLANNED_ADAPTERS } from "../registry.js";
import { LOWTIDE_MARKERS, LOWTIDE_SETTINGS, lowtideReads } from "./ghost-docs-example.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/ghost.md");
const recipes = read("docs/integrations/recipes/index.md");
const nav = read("docs/nav.ts");

const block = (lang: string, title: string): string[] =>
  [
    ...page.matchAll(new RegExp("```" + lang + " title=" + title + "\\n([\\s\\S]*?)\\n```", "g")),
  ].map((m) => m[1] ?? "");

describe("Ghost stays off the key-in-address path (open question 53)", () => {
  it("has no adapter of its own, built or planned", () => {
    expect(BUILT_ADAPTERS.has("ghost")).toBe(false);
    expect(PLANNED_ADAPTERS.some((p) => p.id === "ghost")).toBe(false);
  });

  it("its recipe is still marked blocked, so a run asks for no key", () => {
    const recipe = JSON.parse(read("docs/integrations/recipes/ghost.json")) as {
      settings: { api: { blocked?: string } };
    };
    expect(recipe.settings.api.blocked).toBe("key-in-address");
  });

  it("the sitemap and feeds settings the page shows are valid, and ask for no key", () => {
    const shown = block("json", "gaugeline\\.adapters\\.json");
    expect(shown).toHaveLength(1);
    expect(adaptersConfigSchema.parse(JSON.parse(shown[0] ?? "null"))).toEqual({
      adapters: [LOWTIDE_SETTINGS],
    });
    expect(shown[0]).not.toMatch(/key|token|secret/i);
  });
});

describe("docs/integrations/ghost.md", () => {
  it("the run header it shows is the line the sitemap and feeds adapter prints", () => {
    const built = BUILT_ADAPTERS.get("sitemap-feed");
    expect(built).toBeDefined();
    expect(block("text", "Header")).toEqual([
      adapterHeader(built?.describe ?? { name: "", docsUrl: "", keyKind: "read-only" }),
    ]);
  });

  it("the output it shows for Lowtide Roasters is what the adapter reads", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toBe(await lowtideReads());
  });

  it("shows no text from the site's pages or feed", () => {
    for (const marker of Object.values(LOWTIDE_MARKERS)) expect(page).not.toContain(marker);
  });

  it("says plainly that no key is sent, why, and what cannot run", () => {
    expect(page).toContain("**The key first.** None.");
    expect(page).toContain("open question 53");
    expect(page.toLowerCase()).toContain(
      "members-only posts whose full text appears in the public page",
    );
    for (const needle of ["draftsReachable", "fieldCounts", "fieldHashes", "members"])
      expect(page).toContain(needle);
    expect(page).toContain("uncited");
  });

  it("cites the vendor package it checked, with the version, and shows no key-shaped value", () => {
    expect(page).toContain("@tryghost/content-api");
    expect(page).toContain("1.12.13");
    expect(page).not.toMatch(/key=[0-9a-f]{8,}/i);
  });

  it("is in the docs navigation, and the recipe page points at it", () => {
    expect(nav).toContain('slug: "integrations/ghost"');
    expect(recipes).toContain("/docs/integrations/ghost");
  });
});
