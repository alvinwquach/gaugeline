import { describe, expect, it } from "vitest";
import { createDrupalAdapter } from "../drupal.js";
import { requestProblems } from "./contract.js";
import { loadRecipeFiles, replay } from "./recipe-harness.js";

/**
 * The native Drupal adapter must pass the recipe's recorded-response test (docs/integrations/recipes/drupal-jsonapi.json
 * and drupal-jsonapi.recorded.json, from the generic API adapter): the same recorded answers must give the same types,
 * field counts and fingerprints. The recipe stays as the fallback. Two things differ by design: the recipe's endpoint is
 * its own setting and the native adapter reads DRUPAL_URL (the recipe's endpoint without /jsonapi), and the native
 * adapter keeps no key for a published read, so the test also checks that no request carries one.
 */
const { recipe, recording } = loadRecipeFiles().find((r) => r.recipe.recipe === "drupal-jsonapi")!;

const make = (w: Parameters<Parameters<typeof replay>[1]>[0]) =>
  createDrupalAdapter({
    env: { DRUPAL_URL: (recipe.settings.api?.endpoint ?? "").replace(/\/jsonapi$/, "") },
    fetcher: w.fetcher,
    sleep: w.sleep,
    settings: {
      id: "drupal",
      ...(recipe.settings.fingerprint ? { fingerprint: recipe.settings.fingerprint } : {}),
    },
  });

describe("the native Drupal adapter over the recipe's recorded answers", () => {
  it("gives the recipe's expected types, field counts and fingerprints", async () => {
    const got = await replay(recording, make);
    expect(got.misses).toEqual([]);
    expect(got.unused()).toEqual([]);
    expect(got.answers).toEqual(recording.expect);
  });

  it("only sends GET, and no credential with a published read", async () => {
    const got = await replay(recording, make);
    expect(got.seen.length).toBeGreaterThan(0);
    expect(requestProblems(got.seen)).toEqual([]);
    for (const s of got.seen) expect(s.headers.authorization).toBeUndefined();
  });
});
