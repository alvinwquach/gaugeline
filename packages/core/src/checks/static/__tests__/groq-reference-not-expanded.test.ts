import { describe, expect, it } from "vitest";
import { parseResult } from "../../../result.js";
import { fixtureTree, registered, runOne, spots, treeOf } from "./tokens-forms-helpers.js";

const ID = "groq-reference-not-expanded";

const schema = (extra = "") =>
  `import { defineField, defineType } from "sanity";\nexport const post = defineType({ name: "post", type: "document", fields: [\n  defineField({ name: "title", type: "string" }),\n  defineField({ name: "author", type: "reference", to: [{ type: "person" }] }),\n${extra}]});\n`;
const run = (query: string, extra = "") =>
  runOne(
    ID,
    treeOf({ "schema/post.ts": schema(extra), "lib/q.ts": `export const Q = \`${query}\`;\n` }),
  );

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the query that lists a reference and an array of references with no ->", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(spots(result)).toEqual(["lib/queries.ts:5", "lib/queries.ts:6"]);
      expect(result.findings.map((f) => f.evidence)).toEqual([
        'lib/queries.ts: the query asks for "writer" without ->, and schemaTypes/post.ts declares it as a reference.',
        'lib/queries.ts: the query asks for "seasons" without ->, and schemaTypes/post.ts declares it as a reference.',
      ]);
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the query that follows both", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("what it finds", () => {
    const cases: [string, string][] = [
      ["a bare name at the end", '*[_type == "post"]{ title, author }'],
      ["a bare name in the middle", '*[_type == "post"]{ author, title }'],
      ["an alias of it", '*[_type == "post"]{ "writer": author }'],
      ["on its own line", '*[_type == "post"]{\n  title,\n  author\n}'],
    ];
    it.each(cases)("%s", async (_name, query) => {
      expect((await run(query)).findings).toHaveLength(1);
    });
  });

  describe("what it leaves alone", () => {
    const quiet: [string, string][] = [
      ["a followed reference", '*[_type == "post"]{ title, author->{ name } }'],
      ["a followed reference with a field", '*[_type == "post"]{ "name": author->name }'],
      ["its _ref", '*[_type == "post"]{ "id": author._ref }'],
      ["a filter on it", '*[_type == "post" && author._ref == $id]{ title }'],
      ["a defined() on it", '*[_type == "post" && defined(author)]{ title }'],
      ["a field that is not a reference", '*[_type == "post"]{ title }'],
      ["the word in a string", '*[_type == "post" && title == "author"]{ title }'],
      ["a longer name", '*[_type == "post"]{ authorName }'],
    ];
    it.each(quiet)("%s", async (_name, query) => {
      const result = await run(query);
      expect(result.findings, query).toEqual([]);
      expect(result.passed, query).toEqual([ID]);
    });

    it("an array of references followed with []->", async () => {
      const extra =
        '  defineField({ name: "tags", type: "array", of: [{ type: "reference", to: [{ type: "tag" }] }] }),\n';
      expect((await run('*[_type == "post"]{ tags[]->title }', extra)).passed).toEqual([ID]);
      expect((await run('*[_type == "post"]{ tags }', extra)).findings).toHaveLength(1);
    });
  });

  describe("not sure is not a pass", () => {
    it("no schema in the folder", async () => {
      const result = await runOne(
        ID,
        treeOf({ "lib/q.ts": 'export const Q = `*[_type == "post"]{ author }`;' }),
      );
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck[0]?.reason).toMatch(/no Sanity schema/);
    });
    it("a schema but no query written in the source", async () => {
      const result = await runOne(ID, treeOf({ "schema/post.ts": schema() }));
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck[0]?.reason).toMatch(/no GROQ query/);
    });
    it("a source file left out", async () => {
      const tree = treeOf(
        {
          "schema/post.ts": schema(),
          "lib/q.ts": 'export const Q = `*[_type == "post"]{ title }`;',
        },
        { skipped: new Map([["big.ts", "too-large"]]) },
      );
      expect((await runOne(ID, tree)).passed).toEqual([]);
    });
    it("a truncated folder", async () => {
      const tree = treeOf(
        {
          "schema/post.ts": schema(),
          "lib/q.ts": 'export const Q = `*[_type == "post"]{ title }`;',
        },
        { truncated: true },
      );
      expect((await runOne(ID, tree)).passed).toEqual([]);
    });
  });
});
