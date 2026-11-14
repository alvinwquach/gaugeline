import { describe, expect, it } from "vitest";
import { revalidateTimeAndTagMixed } from "../revalidate-time-and-tag-mixed.js";
import { fixtureTree, runOne, treeOf } from "./helpers.js";

const ID = "revalidate-time-and-tag-mixed";
const run = (files: Record<string, string>, over = {}) =>
  runOne(revalidateTimeAndTagMixed, treeOf(files, over));
const read = (opts: string) => `export const a = client.fetch(q, {}, ${opts});`;

describe("revalidate-time-and-tag-mixed: fixtures", () => {
  it("fails the read that sets a revalidate time and tags", async () => {
    const out = await runOne(revalidateTimeAndTagMixed, await fixtureTree(ID, "fail"));
    expect(out.passed).toEqual([]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      checkId: ID,
      severity: "medium",
      evidence:
        "lib/events.ts:8: this read sets a revalidate time and tags, so it changes on a timer and on publish.",
      source: { file: "lib/events.ts", line: 8 },
    });
  });

  it("passes the read that uses tags alone", async () => {
    const out = await runOne(revalidateTimeAndTagMixed, await fixtureTree(ID, "pass"));
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });
});

describe("revalidate-time-and-tag-mixed: what counts", () => {
  it("fails unstable_cache options with both, and a segment revalidate beside tagged reads", async () => {
    const cache = await run({
      "lib/a.ts": `export const f = unstable_cache(load, ["k"], { revalidate: 60, tags: ["menu"] });`,
    });
    expect(cache.findings).toHaveLength(1);
    const segment = await run({
      "app/page.tsx": `export const revalidate = 60;\n${read(`{ next: { tags: ["menu"] } }`)}`,
    });
    expect(segment.findings.map((f) => f.evidence)).toEqual([
      "app/page.tsx:1: this file sets a revalidate time and its reads use tags, so they change on a timer and on publish.",
    ]);
  });

  it.each([
    ["a time alone", read(`{ next: { revalidate: 60 } }`)],
    ["tags alone", read(`{ next: { tags: ["menu"] } }`)],
    ["revalidate false with tags", read(`{ next: { revalidate: false, tags: ["menu"] } }`)],
    ["revalidate 0 with tags", read(`{ next: { revalidate: 0, tags: ["menu"] } }`)],
    [
      "a time in one read and tags in another",
      `${read(`{ next: { revalidate: 60 } }`)}\n${read(`{ next: { tags: ["a"] } }`)}`,
    ],
  ])("passes %s", async (_n, file) => {
    const out = await run({ "lib/a.ts": file });
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });

  it("does not count a segment revalidate when the file's reads use no tags", async () => {
    const out = await run({
      "app/page.tsx": `export const revalidate = 60;`,
      "lib/b.ts": read(`{ next: { tags: ["a"] } }`),
    });
    expect(out.findings).toEqual([]);
  });

  it("ignores a comment and a string", async () => {
    const out = await run({
      "lib/a.ts": `// { next: { revalidate: 60, tags: ["x"] } }\nconst s = "revalidate: 60, tags: x";\n${read(`{ next: { tags: ["a"] } }`)}`,
    });
    expect(out.passed).toEqual([ID]);
  });
});

describe("revalidate-time-and-tag-mixed: not sure, and what it never prints", () => {
  it("is unsure when revalidate is not a number", async () => {
    const out = await run({
      "lib/a.ts": read(`{ next: { revalidate: SECONDS, tags: ["menu"] } }`),
    });
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck).toEqual([
      {
        id: ID,
        reason:
          "lib/a.ts:1 sets revalidate from something other than a number or false, so Gaugeline cannot tell whether it is a timer.",
        url: "source:./my-site",
      },
    ]);
  });

  it("is unsure, not passed, when a code file was left out; passes a folder with no reads", async () => {
    const left = await run({ "a.ts": "export {};" }, { skipped: { "lib/big.ts": "too-large" } });
    expect(left.passed).toEqual([]);
    expect((await run({ "a.ts": "export {};" })).passed).toEqual([ID]);
  });

  it("never prints the tags or the time", async () => {
    const out = await run({
      "lib/a.ts": read(`{ next: { revalidate: 86400, tags: ["secret-tag-0007"] } }`),
    });
    expect(out.findings).toHaveLength(1);
    const printed = JSON.stringify(out);
    expect(printed).not.toContain("secret-tag-0007");
    expect(printed).not.toContain("86400");
  });
});
