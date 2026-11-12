import { describe, expect, it } from "vitest";
import { createPayloadAdapter } from "../payload.js";
import { requestProblems } from "./contract.js";
import { loadRecipeFiles, replay, type Recording } from "./recipe-harness.js";

/**
 * The native Payload adapter must pass the recipe's recorded-response test (docs/integrations/recipes/payload.json
 * and payload.recorded.json, from the generic API adapter): the same recorded answers must give the same types,
 * field counts and fingerprints. The recipe stays as the fallback. Two things differ by design, and the test maps
 * them: the recipe's key variable is GAUGELINE_API_PAYLOAD_API_KEY and the native adapter reads PAYLOAD_API_KEY; and
 * the recipe calls its type "post" (a label, for the route /posts) while the native adapter's type is the Payload
 * collection slug, "posts". Everything else is compared as it is.
 */
const { recipe, recording } = loadRecipeFiles().find((r) => r.recipe.recipe === "payload")!;
const LABEL = "post";
const SLUG = "posts";
const KEY = recording.env.GAUGELINE_API_PAYLOAD_API_KEY ?? "";

/** The recording with its type label replaced by the collection slug the native adapter is asked for. */
const native: Recording = {
  ...recording,
  expect: {
    ...recording.expect,
    options: {
      ...recording.expect.options,
      types: [SLUG],
      fields: { [SLUG]: recording.expect.options.fields?.[LABEL] ?? [] },
    },
    countType: SLUG,
  },
};

const make = (w: Parameters<Parameters<typeof replay>[1]>[0]) =>
  createPayloadAdapter({
    env: { PAYLOAD_URL: recipe.settings.api?.endpoint ?? "", PAYLOAD_API_KEY: KEY },
    fetcher: w.fetcher,
    sleep: w.sleep,
    settings: {
      id: "payload",
      fingerprint: { [SLUG]: recipe.settings.fingerprint?.[LABEL] ?? [] },
      urls: { [SLUG]: recipe.settings.urls?.[LABEL] ?? "" },
    },
  });

describe("the native Payload adapter over the recipe's recorded answers", () => {
  it("gives the recipe's expected types, field counts and fingerprints", async () => {
    const got = await replay(native, make);
    expect(got.misses).toEqual([]);
    expect(got.unused()).toEqual([]);
    expect(got.answers.types).toEqual(recording.expect.types?.map((t) => ({ ...t, name: SLUG })));
    expect(got.answers.fieldCounts).toEqual(recording.expect.fieldCounts);
    expect(got.answers.published).toEqual(
      recording.expect.published?.map((d) => ({ ...d, type: SLUG })),
    );
  });

  it("only sends GET, with the key in the recipe's header form and never in an address", async () => {
    const got = await replay(native, make);
    expect(got.seen.length).toBeGreaterThan(0);
    expect(requestProblems(got.seen)).toEqual([]);
    for (const s of got.seen) {
      expect(s.headers.authorization).toBe(`users API-Key ${KEY}`);
      expect(s.url).not.toContain(KEY);
    }
  });
});
