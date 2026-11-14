import { describe, expect, it } from "vitest";
import { parseResult } from "../../../result.js";
import {
  expectNoneOf,
  fixtureTree,
  registered,
  runOne,
  spots,
  treeOf,
} from "./tokens-forms-helpers.js";

const ID = "presentation-main-documents-missing";
const IMPORT = 'import { defineDocuments, presentationTool } from "sanity/presentation";\n';
const config = (options: string, imp = IMPORT): string =>
  `${imp}export default { plugins: [presentationTool(${options})] };\n`;
const flagged = async (code: string, path = "sanity.config.ts") =>
  (await runOne(ID, treeOf({ [path]: code }))).findings.map((f) => f.evidence);

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the Presentation tool with no resolve option", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(spots(result)).toEqual(["sanity.config.ts:12"]);
      expect(result.findings[0]).toMatchObject({
        checkId: ID,
        severity: "low",
        evidence:
          "sanity.config.ts:12: presentationTool has no resolve option, so no route is mapped to a document.",
      });
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the Presentation tool that maps routes to documents", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("what it finds", () => {
    it("a resolve with locations and no mainDocuments", async () => {
      expect(await flagged(config("{ previewUrl: '/', resolve: { locations: {} } }"))).toEqual([
        "sanity.config.ts:2: presentationTool has no resolve.mainDocuments, so no route is mapped to a document.",
      ]);
    });
    it("an empty mainDocuments list", async () => {
      expect(await flagged(config("{ previewUrl: '/', resolve: { mainDocuments: [] } }"))).toEqual([
        "sanity.config.ts:2: presentationTool has an empty resolve.mainDocuments, so no route is mapped to a document.",
      ]);
    });
    it("an options object with no resolve, from @sanity/presentation and in a plain config", async () => {
      expect(
        await flagged(
          config(
            "{ previewUrl: '/' }",
            'import { presentationTool } from "@sanity/presentation";\n',
          ),
        ),
      ).toHaveLength(1);
      expect(await flagged(config("{ previewUrl: '/' }"), "studio/config.js")).toHaveLength(1);
    });
    it("only the top level of the options counts: a resolve nested deeper is not the option", async () => {
      expect(
        await flagged(config("{ previewUrl: { resolve: { mainDocuments: [{}] } } }")),
      ).toHaveLength(1);
    });
  });

  describe("what it leaves alone", () => {
    it.each([
      [
        "a mainDocuments list",
        "{ previewUrl: '/', resolve: { mainDocuments: [{ route: '/a', type: 'a' }] } }",
      ],
      [
        "defineDocuments",
        "{ previewUrl: '/', resolve: { mainDocuments: defineDocuments([{ route: '/a', type: 'a' }]) } }",
      ],
      ["a mainDocuments next to locations", "{ resolve: { locations: {}, mainDocuments: docs } }"],
    ])("%s", async (_n, options) => {
      expect(await flagged(config(options))).toEqual([]);
    });
    it("a file that does not import the Presentation tool", async () => {
      expect(
        await flagged(
          "export const presentationTool = (o) => o;\nconst x = presentationTool({ a: 1 });\n",
        ),
      ).toEqual([]);
    });
    it("a call in a comment or a test file", async () => {
      expect(
        await flagged(`${IMPORT}// presentationTool({ previewUrl: '/' })\nexport {};\n`),
      ).toEqual([]);
      expect(await flagged(config("{ previewUrl: '/' }"), "sanity.config.test.ts")).toEqual([]);
    });
  });

  describe("not sure is not a pass", () => {
    it.each([
      ["options held in a variable", "options"],
      ["a spread of other options", "{ previewUrl: '/', ...shared }"],
      ["a resolve held in a variable", "{ previewUrl: '/', resolve }"],
      ["a resolve from a call", "{ previewUrl: '/', resolve: makeResolve() }"],
      ["a resolve with a spread", "{ resolve: { ...base } }"],
    ])("%s is could-not-check", async (_n, options) => {
      const result = await runOne(ID, treeOf({ "sanity.config.ts": config(options) }));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck.map((c) => c.id)).toEqual([ID]);
    });

    it("a folder with no source is could-not-check, and so is one with a file left out", async () => {
      expect((await runOne(ID, treeOf({}))).passed).toEqual([]);
      const left = await runOne(
        ID,
        treeOf({ "a.ts": "export {};" }, { skipped: new Map([["b.ts", "too-large"]]) }),
      );
      expect(left.passed).toEqual([]);
    });

    it("a folder with code and no Presentation tool passes", async () => {
      expect((await runOne(ID, treeOf({ "a.ts": "export {};" }))).passed).toEqual([ID]);
    });
  });

  it("names the file and the line and never prints a project id or a route", async () => {
    const result = await runOne(
      ID,
      treeOf({
        "sanity.config.ts": config(
          "{ previewUrl: '/sentinel-route-0029', projectId: 'sentinel-project-0029' }",
        ),
      }),
    );
    expectNoneOf(result, ["sentinel-route-0029", "sentinel-project-0029"]);
  });
});
