import { describe, expect, it } from "vitest";
import { parseResult } from "../../../result.js";
import { fixtureTree, registered, runOne, spots, treeOf } from "./tokens-forms-helpers.js";

const ID = "image-alt-not-validated";
const wrap = (field: string) =>
  `import { defineField, defineType } from "sanity";\nexport const t = defineType({ name: "t", type: "document", fields: [\n${field}\n]});\n`;
const run = (field: string) => runOne(ID, treeOf({ "schema/t.ts": wrap(field) }));
const altField = (validation: string) =>
  `defineField({ name: "photo", type: "image", fields: [defineField({ name: "alt", type: "string"${validation} })] })`;

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the image field with no alt field", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(spots(result)).toEqual(["schemaTypes/dish.ts:8"]);
      expect(result.findings[0]?.evidence).toBe(
        'schemaTypes/dish.ts: the image field "photo" has no required alt-text field.',
      );
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the image field with a required alt", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("what it finds", () => {
    it("an image with no fields", async () => {
      expect((await run('defineField({ name: "photo", type: "image" })')).findings).toHaveLength(1);
    });
    it("an alt field with no validation", async () => {
      expect((await run(altField(""))).findings).toHaveLength(1);
    });
    it("an alt field whose validation is not required", async () => {
      expect((await run(altField(", validation: (Rule) => Rule.max(120)"))).findings).toHaveLength(
        1,
      );
    });
    it("a field of another name", async () => {
      expect(
        (
          await run(
            'defineField({ name: "photo", type: "image", fields: [defineField({ name: "caption", type: "string", validation: (Rule) => Rule.required() })] })',
          )
        ).findings,
      ).toHaveLength(1);
    });
    it("an image as a member of an array", async () => {
      const field = 'defineField({ name: "gallery", type: "array", of: [{ type: "image" }] })';
      const result = await run(field);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.evidence).toContain('"gallery"');
    });
  });

  describe("what it leaves alone", () => {
    it("a required alt", async () => {
      expect((await run(altField(", validation: (Rule) => Rule.required()"))).passed).toEqual([ID]);
    });
    it("a required altText with a message", async () => {
      expect(
        (
          await run(
            altField(", validation: (rule) => rule.required().error('Add a description')").replace(
              '"alt"',
              '"altText"',
            ),
          )
        ).passed,
      ).toEqual([ID]);
    });
    it("fields that are not images", async () => {
      expect((await run('defineField({ name: "title", type: "string" })')).passed).toEqual([ID]);
    });
    it("a comment", async () => {
      expect(
        (
          await run(
            '// defineField({ name: "photo", type: "image" })\ndefineField({ name: "title", type: "string" })',
          )
        ).passed,
      ).toEqual([ID]);
    });
  });

  describe("not sure is not a pass", () => {
    it("no schema in the folder", async () => {
      const result = await runOne(ID, treeOf({ "a.ts": 'export const x = { type: "image" };' }));
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck[0]?.reason).toMatch(/no Sanity schema/);
    });
    it("a source file left out", async () => {
      const tree = treeOf(
        { "schema/t.ts": wrap('defineField({ name: "title", type: "string" })') },
        { skipped: new Map([["big.ts", "unreadable"]]) },
      );
      expect((await runOne(ID, tree)).passed).toEqual([]);
    });
  });
});
