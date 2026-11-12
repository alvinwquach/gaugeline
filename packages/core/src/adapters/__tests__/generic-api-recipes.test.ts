import { describe, expect, it } from "vitest";
import { adaptersConfigSchema } from "../config.js";
import { BLOCKED_REASONS } from "../generic-api-config.js";
import { createGenericApiAdapter } from "../generic-api.js";
import { AdapterCouldNotCheck } from "../types.js";
import { requestProblems } from "./contract.js";
import { loadRecipeFiles, replay } from "./recipe-harness.js";

/** The recipes the spec names (C-14), by file name. Adding one is two files here and a section on the recipes page. */
export const RECIPE_IDS = [
  "builder-io",
  "datocms",
  "directus",
  "drupal-jsonapi",
  "ghost",
  "hygraph",
  "joomla",
  "kontent-ai",
  "payload",
  "prismic",
  "storyblok",
];

const all = loadRecipeFiles();

describe("the recipes in docs/integrations/recipes", () => {
  it("are the eleven the spec names, each a mapping file and one recorded-response file", () => {
    expect(all.map((r) => r.recipe.recipe)).toEqual(RECIPE_IDS);
    for (const r of all) {
      expect(r.recipe.format).toBe(1);
      expect(r.recording.format).toBe(1);
      expect(r.recording.recipe).toBe(r.recipe.recipe);
      expect(r.recording.provenance).toContain("Invented");
    }
  });

  describe.each(all)("$recipe.name", ({ recipe, recording }) => {
    const settings = recipe.settings;
    const blocked = settings.api?.blocked !== undefined;
    // A blocked recipe is replayed with the block lifted, to prove the mapping reads the shape; the real mapping is tested below.
    const lifted = { ...settings, api: { ...settings.api!, blocked: undefined } };
    const make = (w: Parameters<Parameters<typeof replay>[1]>[0]) =>
      createGenericApiAdapter({ env: w.env, fetcher: w.fetcher, sleep: w.sleep, settings: lifted });

    it("is a valid entry of gaugeline.adapters.json", () => {
      const parsed = adaptersConfigSchema.safeParse({ adapters: [settings] });
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });

    it("reads its recorded answers into the expected types, counts and fingerprints", async () => {
      const got = await replay(recording, make);
      expect(got.misses).toEqual([]);
      expect(got.unused()).toEqual([]);
      expect(got.answers).toEqual(recording.expect);
      expect(got.answers.types?.length).toBeGreaterThan(0);
      expect(got.answers.published?.length).toBeGreaterThan(0);
    });

    it("only ever sends GET, with the key in a header and never in an address", async () => {
      const got = await replay(recording, make);
      expect(got.seen.every((s) => s.method === "GET")).toBe(true);
      expect(requestProblems(got.seen)).toEqual([]);
      for (const s of got.seen)
        for (const v of Object.values(recording.env)) expect(s.url).not.toContain(v);
      if (settings.api?.auth !== undefined)
        for (const s of got.seen.filter((x) => x.url.startsWith(settings.api?.endpoint ?? "?")))
          expect(s.headers[settings.api.auth.header.toLowerCase()]).toBe(
            `${settings.api.auth.prefix ?? ""}${recording.env[settings.api.auth.env]}`,
          );
    });

    it("shows no text from the content: the answers are ids, addresses, times and hashes", async () => {
      const text = JSON.stringify((await replay(recording, make)).answers);
      const bodies = JSON.stringify(recording.exchanges.map((e) => e.response.body));
      for (const word of bodies.match(/"(?:title|intro|summary)":"([^"]{6,})"/g) ?? [])
        expect(text).not.toContain(word.split(":")[1]?.replaceAll('"', "") ?? "###");
    });

    it.runIf(blocked)("as written it asks for nothing and says why", async () => {
      const got = await replay(recording, ({ env, fetcher, sleep }) =>
        createGenericApiAdapter({ env, fetcher, sleep, settings }),
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(got).toBeInstanceOf(AdapterCouldNotCheck);
      expect((got as AdapterCouldNotCheck).reason).toContain(BLOCKED_REASONS["key-in-address"]);
    });

    it("a wrong path in the mapping fails validation", () => {
      const broken = JSON.parse(JSON.stringify(settings)) as typeof settings;
      const first = Object.values(broken.api?.collections ?? {})[0];
      if (first) first.items = "no/leading/slash";
      expect(adaptersConfigSchema.safeParse({ adapters: [broken] }).success).toBe(false);
    });
  });
});
