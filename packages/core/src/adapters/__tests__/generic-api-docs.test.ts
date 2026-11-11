import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptersConfigSchema } from "../config.js";
import { GENERIC_API_LIMITS } from "../generic-api-config.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { HERON_SETTINGS, heronReads } from "./generic-api-docs-example.js";
import { loadRecipeFiles } from "./recipe-harness.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/generic-api.md");
const recipesPage = read("docs/integrations/recipes/index.md");
const index = read("docs/integrations/index.md");

const block = (md: string, lang: string, title: string): string[] =>
  [...md.matchAll(new RegExp("```" + lang + " title=" + title + "\\n([\\s\\S]*?)\\n```", "g"))].map(
    (m) => m[1] ?? "",
  );

describe("docs/integrations/generic-api.md", () => {
  it("the settings it shows are valid and are the ones the example reads with", () => {
    const shown = block(page, "json", "gaugeline\\.adapters\\.json");
    expect(shown).toHaveLength(1);
    expect(adaptersConfigSchema.parse(JSON.parse(shown[0] ?? "null"))).toEqual({
      adapters: [HERON_SETTINGS],
    });
  });

  it("the read it shows for Heron Yoga Studio is what the adapter reads", async () => {
    const outputs = block(page, "json", "Output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toBe(await heronReads());
  });

  it("states the bounds the code keeps and the rules the adapter never breaks", () => {
    expect(page).toContain(`at most ${GENERIC_API_LIMITS.pageSize}`);
    expect(page).toContain(`at most ${GENERIC_API_LIMITS.maxPages}`);
    expect(page).toContain("every request is a GET");
    expect(page).toContain("open question 53");
    expect(page).toContain("[docs]");
    expect(page).toContain(`\`${BUILT_ADAPTERS.get("generic-api")?.describe.keyKind}\``);
  });

  it("is linked from the content systems page as built, with the registry's name", () => {
    const built = BUILT_ADAPTERS.get("generic-api");
    const row = index.split("\n").find((l) => l.startsWith(`| ${built?.describe.name}`));
    expect(row).toMatch(/\| built\s+\|/);
    expect(row).toContain("/docs/integrations/generic-api");
  });
});

describe("docs/integrations/recipes/index.md", () => {
  it("has a section for every recipe, with the mapping file it ships and the page it cites", () => {
    for (const { recipe } of loadRecipeFiles()) {
      expect(recipesPage).toContain(`## ${recipe.name}\n`);
      const shown = block(recipesPage, "json", `${recipe.recipe}\\.json`);
      expect(shown).toHaveLength(1);
      expect(JSON.parse(shown[0] ?? "null")).toEqual(recipe);
    }
  });

  it("carries an inline uncited note in every recipe's section", () => {
    expect(recipesPage.match(/\*\*Uncited:\*\*/g)).toHaveLength(loadRecipeFiles().length);
  });

  it("is honest that the shapes are uncited, and says which recipes are blocked", () => {
    expect(recipesPage).toContain("**uncited**");
    expect(recipesPage.match(/\*\*Not usable yet\.\*\*/g)).toHaveLength(
      loadRecipeFiles().filter((r) => r.recipe.settings.api?.blocked !== undefined).length,
    );
  });
});
