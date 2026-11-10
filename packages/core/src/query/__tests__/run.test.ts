import { describe, expect, it } from "vitest";
import {
  sanityCountsTransport,
  type FakeSanity,
  type SeenSanityRequest,
} from "../../../../testkit/src/index.js";
import { QUERY_CHECKS, createQueryRegistry } from "../../checks/query-counts.js";
import { ConfigError } from "../../errors.js";
import { createFetcher } from "../../fetcher.js";
import { resultSchema } from "../../result.js";
import { TITLES } from "../counts.js";
import { compareQueries } from "../run.js";
import type { QueryShape } from "../shape.js";

const NOW = new Date("2026-11-10T12:00:00Z");

const shapeOf = (
  type: string,
  paths: string[],
  line: number,
  excludesDrafts = true,
): QueryShape => {
  const source = { file: "src/q.ts", line };
  return {
    type,
    fields: paths.map((path) => ({ path, deref: false, source })),
    excludesDrafts,
    params: [],
    source,
  };
};

function run(shapes: QueryShape[], spec: FakeSanity, env: Record<string, string> = {}) {
  const seen: SeenSanityRequest[] = [];
  return {
    seen,
    done: compareQueries({
      shapes,
      env: { SANITY_PROJECT_ID: "cprhl1b4", SANITY_DATASET: "production", ...env },
      fetcher: createFetcher({ transport: sanityCountsTransport(spec, seen), timeoutMs: 5000 }),
      now: NOW,
    }),
  };
}

describe("the query checks", () => {
  it("have four ids, and the titles the findings carry", () => {
    expect(QUERY_CHECKS.map((c) => c.id)).toEqual([
      "query-field-absent",
      "query-type-empty",
      "query-field-partial",
      "query-no-drafts-filter",
    ]);
    expect(QUERY_CHECKS.map((c) => c.title)).toEqual([
      TITLES.absent,
      TITLES.empty,
      TITLES.partial,
      TITLES.drafts,
    ]);
    expect(createQueryRegistry().all()).toHaveLength(4);
  });

  it("each check reports only its own finding", async () => {
    const shapes = [
      shapeOf("post", ["author", "summary"], 3, false),
      shapeOf("topic", ["title"], 9),
    ];
    const { done } = run(shapes, {
      types: { post: { total: 10, defined: { author: 0, summary: 4 } } },
    });
    const { result } = await done;
    expect(result.findings.map((f) => f.checkId)).toEqual([
      "query-field-absent",
      "query-type-empty",
      "query-no-drafts-filter",
      "query-field-partial",
    ]);
    expect(result.passed).toEqual([]);
    expect(() => resultSchema.parse(result)).not.toThrow();
  });

  it("a clean repository passes all four", async () => {
    const { done } = run([shapeOf("post", ["title"], 3)], { types: { post: { total: 3 } } });
    const { result } = await done;
    expect(result.findings).toEqual([]);
    expect(result.passed).toHaveLength(4);
  });
});

describe("compareQueries", () => {
  it("asks once for each type and keeps the counts in a Map", async () => {
    const { done, seen } = run(
      [shapeOf("post", ["title"], 1), shapeOf("post", ["body"], 2), shapeOf("page", ["title"], 3)],
      { types: { post: { total: 3 }, page: { total: 1 } } },
    );
    const r = await done;
    expect(seen).toHaveLength(2);
    expect([...r.counts.keys()]).toEqual(["post", "page"]);
    expect(r.result.sampled["query-types"]).toEqual({ seen: 2, taken: 2, limit: 2 });
  });

  it("no queries make no request", async () => {
    const { done, seen } = run([], { types: {} });
    const r = await done;
    expect(seen).toEqual([]);
    expect(r.result.findings).toEqual([]);
  });

  it("a private dataset with no token is a ConfigError that names SANITY_TOKEN and the Viewer role", async () => {
    const { done } = run([shapeOf("post", ["title"], 1)], { types: {}, token: true });
    const err = await done.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("SANITY_TOKEN");
    expect((err as Error).message).toContain("Viewer");
  });

  it("a malformed project id is a ConfigError", async () => {
    const { done } = run(
      [shapeOf("post", ["title"], 1)],
      { types: {} },
      { SANITY_PROJECT_ID: "No Way" },
    );
    await expect(done).rejects.toBeInstanceOf(ConfigError);
  });

  it("an unset dataset is noted", async () => {
    const seen: SeenSanityRequest[] = [];
    const r = await compareQueries({
      shapes: [shapeOf("post", ["title"], 1)],
      env: { SANITY_PROJECT_ID: "cprhl1b4" },
      fetcher: createFetcher({ transport: sanityCountsTransport({ types: {} }, seen) }),
      now: NOW,
    });
    expect(r.notices.join(" ")).toContain('"production" was assumed');
  });
});
