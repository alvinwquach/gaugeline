import { describe, expect, it } from "vitest";
import { parseResult } from "../../../result.js";
import { fixtureTree, registered, runOne, spots, treeOf } from "./tokens-forms-helpers.js";

const ID = "section-type-component-mismatch";
const schema = (members: string, field = "sections") =>
  `import { defineField, defineType } from "sanity";\nexport const page = defineType({ name: "page", type: "document", fields: [\n  defineField({ name: "${field}", type: "array", of: [${members}] }),\n]});\nexport const hero = defineType({ name: "hero", type: "object", fields: [] });\n`;
const renderer = (body: string) => `export const r = (s: { _type: string }) => {\n${body}\n};\n`;
const run = (members: string, body: string, extra: Record<string, string> = {}) =>
  runOne(
    ID,
    treeOf({ "schema/page.ts": schema(members), "components/S.tsx": renderer(body), ...extra }),
  );

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the schema section that the renderer's map lacks", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(spots(result)).toEqual(["schemaTypes/page.ts:10"]);
      expect(result.findings[0]?.evidence).toBe(
        'schemaTypes/page.ts: the section type "menuGallery" has no component in the renderer, so it renders nothing.',
      );
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the folder where every section has a component", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("what it finds", () => {
    it("a section with no case or key", async () => {
      const result = await run(
        '{ type: "hero" }, { type: "gallery" }',
        'switch (s._type) { case "hero": return 1; default: return null; }',
      );
      expect(result.findings.map((f) => f.evidence)).toEqual([
        'schema/page.ts: the section type "gallery" has no component in the renderer, so it renders nothing.',
      ]);
    });
    it("every spelling of the array's field name", async () => {
      for (const field of ["blocks", "pageBuilder", "content", "modules"]) {
        const result = await runOne(
          ID,
          treeOf({
            "schema/page.ts": schema('{ type: "gallery" }', field),
            "components/S.tsx": renderer("return s._type;"),
          }),
        );
        expect(result.findings, field).toHaveLength(1);
      }
    });
    it("a component with no schema type", async () => {
      const result = await run(
        '{ type: "hero" }',
        "const c = { hero: Hero, teaser: Teaser };\nreturn c[s._type];",
      );
      expect(result.findings.map((f) => f.evidence)).toEqual([
        'components/S.tsx: the renderer has a component for "teaser", and no schema type has that name.',
      ]);
    });
  });

  describe("what it leaves alone", () => {
    it("a case, a key and a comparison all count as handled", async () => {
      for (const body of [
        'switch (s._type) { case "gallery": return 1; }',
        'const c = { "gallery": G, hero: H };\nreturn c[s._type];',
        'return s._type === "gallery";',
      ]) {
        const result = await run('{ type: "gallery" }', body);
        expect(result.findings, body).toEqual([]);
        expect(result.passed, body).toEqual([ID]);
      }
    });
    it("Sanity's own types in the array", async () => {
      const result = await run(
        '{ type: "block" }, { type: "image" }, { type: "hero" }',
        'return s._type === "hero";',
      );
      expect(result.passed).toEqual([ID]);
    });
    it("a type used outside a sections array", async () => {
      const result = await runOne(
        ID,
        treeOf({
          "schema/page.ts": schema('{ type: "hero" }', "tags"),
          "components/S.tsx": renderer("return s._type;"),
        }),
      );
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck[0]?.reason).toMatch(/no array of section types/);
    });
    it("a map with one entry (not a renderer map)", async () => {
      const result = await run(
        '{ type: "hero" }',
        'const c = { solo: Solo };\nreturn s._type === "hero" && c;',
      );
      expect(result.passed).toEqual([ID]);
    });
    it("a comment that names a section", async () => {
      const result = await run('{ type: "gallery" }', '// case "gallery"\nreturn s._type;');
      expect(result.findings).toHaveLength(1);
    });
  });

  describe("not sure is not a pass", () => {
    it("no schema in the folder", async () => {
      const result = await runOne(
        ID,
        treeOf({ "components/S.tsx": renderer('return s._type === "hero";') }),
      );
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck[0]?.reason).toMatch(/no array of section types/);
    });
    it("no renderer in the folder", async () => {
      const result = await runOne(ID, treeOf({ "schema/page.ts": schema('{ type: "hero" }') }));
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck[0]?.reason).toMatch(/no page renderer/);
    });
    it("a source file left out", async () => {
      const tree = treeOf(
        {
          "schema/page.ts": schema('{ type: "hero" }'),
          "components/S.tsx": renderer('return s._type === "hero";'),
        },
        { skipped: new Map([["big.ts", "too-large"]]) },
      );
      expect((await runOne(ID, tree)).passed).toEqual([]);
    });
  });
});
