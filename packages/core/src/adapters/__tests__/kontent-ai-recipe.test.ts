import { describe, expect, it } from "vitest";
import { hashValue } from "../fingerprint.js";
import { createKontentAdapter } from "../kontent-ai.js";
import { requestProblems } from "./contract.js";
import { loadRecipeFiles, replay } from "./recipe-harness.js";

/**
 * The native Kontent.ai adapter must pass the recipe's recorded-response test (docs/integrations/recipes/kontent-ai.json
 * and kontent-ai.recorded.json, from the generic API adapter): the same recorded answers must give the same types, field
 * counts and fingerprints. The recipe stays as the fallback. The recipe takes the environment id from its endpoint; the
 * native adapter takes it from KONTENT_ENVIRONMENT_ID, so the test reads it from the endpoint's path. One thing differs
 * by design, and the test maps it: the recipe's field root is /elements, so it hashes the element object ({ value }, and
 * in the real API also the element's type and name), while the native adapter hashes the element's value, so a renamed
 * element is not a changed text. Everything else is compared as it is.
 */
const { recipe, recording } = loadRecipeFiles().find((r) => r.recipe.recipe === "kontent-ai")!;
const ENVIRONMENT = new URL(recipe.settings.api?.endpoint ?? "").pathname.slice(1);

/** The values the recording holds, by item and field (the recording's own text). */
const TEXT: Record<string, Record<string, unknown>> = Object.fromEntries(
  (
    recording.exchanges.flatMap((e) => (e.response.body as { items?: unknown[] }).items ?? []) as {
      system: { id: string };
      elements: Record<string, { value: unknown }>;
    }[]
  ).map((i) => [
    i.system.id,
    Object.fromEntries(Object.entries(i.elements).map(([k, v]) => [k, v.value])),
  ]),
);

const make = (w: Parameters<Parameters<typeof replay>[1]>[0]) =>
  createKontentAdapter({
    env: { KONTENT_ENVIRONMENT_ID: ENVIRONMENT },
    fetcher: w.fetcher,
    sleep: w.sleep,
    settings: { id: "kontent-ai", fingerprint: { ...recipe.settings.fingerprint } },
  });

describe("the native Kontent.ai adapter over the recipe's recorded answers", () => {
  it("gives the recipe's expected types, field counts and fingerprints", async () => {
    const got = await replay(recording, make);
    expect(got.misses).toEqual([]);
    expect(got.unused()).toEqual([]);
    expect(got.answers.types).toEqual(recording.expect.types);
    expect(got.answers.fieldCounts).toEqual(recording.expect.fieldCounts);
    expect(got.answers.published).toEqual(
      recording.expect.published?.map((d) => ({
        ...d,
        fieldHashes: Object.fromEntries(
          Object.entries(d.fieldHashes).map(([f]) => [f, hashValue(TEXT[d.id]?.[f]) ?? ""]),
        ),
      })),
    );
  });

  it("only sends GET, with no key for a public project, and nothing in the address but its own parameters", async () => {
    const got = await replay(recording, make);
    expect(got.seen.length).toBeGreaterThan(0);
    expect(requestProblems(got.seen)).toEqual([]);
    for (const s of got.seen) {
      expect(s.headers.authorization).toBeUndefined();
      expect([...new URL(s.url).searchParams.keys()].sort()).toEqual(
        expect.arrayContaining(["includeTotalCount", "limit", "order", "skip"]),
      );
    }
  });
});
