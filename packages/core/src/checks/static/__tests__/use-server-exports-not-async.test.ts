import { describe, expect, it } from "vitest";
import { parseResult } from "../../../result.js";
import { fixtureTree, registered, runOne, spots, treeOf } from "./tokens-forms-helpers.js";

const ID = "use-server-exports-not-async";
const run = (code: string, path = "app/actions.ts") => runOne(ID, treeOf({ [path]: code }));
const bad = async (body: string) =>
  (await run(`"use server";\n${body}`)).findings.map((f) => f.evidence);

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the file that exports a constant", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(spots(result)).toEqual(["app/enquiry/actions.ts:3"]);
      expect(result.findings[0]?.evidence).toBe(
        'app/enquiry/actions.ts: exports MAX_GUESTS, a value that is not an async function, from a "use server" file.',
      );
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the file that keeps the constant in a module of its own", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("what it finds", () => {
    const cases: [string, string][] = [
      ["a literal", "export const A = 1;"],
      ["an object", "export const OPTIONS = { a: 1 };"],
      ["an array", "export const LIST = [1, 2];"],
      ["a template string", "export const S = `x`;"],
      ["a plain function", "export function helper() { return 1; }"],
      ["a non-async arrow", "export const f = (a: number) => a + 1;"],
      ["a single-parameter arrow", "export const f = a => a;"],
      ["a class", "export class Thing {}"],
      ["an enum", "export enum Level { A }"],
      ["new", "export const d = new Map();"],
      ["a default plain function", "export default function () {}"],
      ["a named export of a plain function", "function helper() {}\nexport { helper };"],
      ["a typed constant", "export const A: number = 1;"],
      ["single quotes for the directive", ""],
    ];
    it.each(cases)("%s", async (name, body) => {
      if (body === "") {
        const out = (await run("'use server'\nexport const A = 1;")).findings;
        expect(out).toHaveLength(1);
        return;
      }
      expect(await bad(body), name).toHaveLength(1);
    });
  });

  describe("what it leaves alone", () => {
    const quiet: [string, string][] = [
      ["an async function", "export async function a() {}"],
      ["an async arrow", "export const a = async () => {};"],
      [
        "an async arrow with a typed parameter",
        "export const a = async (x: string): Promise<void> => {};",
      ],
      ["an async default", "export default async function () {}"],
      ["a type and an interface", "export type A = 1;\nexport interface B { c: 1 }"],
      ["a named async function", "async function a() {}\nexport { a };"],
      ["a type in the export list", "type T = 1;\nexport type { T };"],
      [
        "an export inside a function body",
        "export async function a() { const x = { y: 1 }; return x; }",
      ],
    ];
    it.each(quiet)("%s", async (_name, body) => {
      const result = await run(`"use server";\n${body}`);
      expect(result.findings, body).toEqual([]);
      expect(result.passed, body).toEqual([ID]);
    });

    it("a file with no directive, whatever it exports", async () => {
      const result = await run("export const A = 1;\nexport class B {}");
      expect(result.passed).toEqual([ID]);
    });
    it("the directive anywhere but first (inside a function)", async () => {
      const result = await run(
        'export async function a() {\n  "use server";\n}\nexport const A = 1;',
      );
      expect(result.passed).toEqual([ID]);
    });
    it("a comment that exports a value", async () => {
      expect(await bad("// export const A = 1;\nexport async function a() {}")).toEqual([]);
    });
  });

  describe("not sure is not a pass", () => {
    const unsure: [string, string][] = [
      ["a wrapped call", "export const a = createAction(async () => {});"],
      ["an imported name in the export list", 'import { a } from "./a";\nexport { a };'],
      ["a re-export", 'export { a } from "./a";'],
      ["export *", 'export * from "./a";'],
      ["a default expression", "export default createAction();"],
    ];
    it.each(unsure)("%s is could-not-check, not a pass", async (_name, body) => {
      const result = await run(`"use server";\n${body}`);
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck.map((c) => c.id)).toEqual([ID]);
    });

    it("no source is could-not-check", async () => {
      const result = await runOne(ID, treeOf({}));
      expect(result.passed).toEqual([]);
    });
    it("a source file left out is could-not-check", async () => {
      const result = await runOne(
        ID,
        treeOf({ "a.ts": "export {};" }, { skipped: new Map([["b.ts", "too-large"]]) }),
      );
      expect(result.passed).toEqual([]);
    });
  });
});
