import { describe, expect, it } from "vitest";
import { parseResult } from "../../../result.js";
import { fixtureTree, registered, runOne, spots, treeOf } from "./tokens-forms-helpers.js";

const ID = "token-required-at-import";
const flagged = async (code: string, path = "lib/sanity.ts") =>
  (await runOne(ID, treeOf({ [path]: code }))).findings.map((f) => f.evidence);

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the module that throws at import when the token is missing", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(spots(result)).toEqual(["lib/sanity.ts:5"]);
      expect(result.findings[0]?.evidence).toBe(
        "lib/sanity.ts: throws when SANITY_API_READ_TOKEN is missing, as soon as the module is imported.",
      );
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the module that reads it inside the function", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("what it finds", () => {
    const cases: [string, string][] = [
      [
        "an if on the variable with a throw",
        'if (!process.env.SANITY_API_WRITE_TOKEN) throw new Error("x");',
      ],
      [
        "an if on a constant set from it",
        'const t = process.env.SANITY_API_READ_TOKEN;\nif (t === undefined) {\n  throw new Error("x");\n}',
      ],
      [
        "a bracketed read",
        'if (!process.env["CONTENTFUL_MANAGEMENT_TOKEN"]) { throw new Error("x"); }',
      ],
      ["invariant", "invariant(process.env.SANITY_API_READ_TOKEN, 'token');"],
      ["assert on a constant", "const t = process.env.PAYLOAD_SECRET;\nassert(t);"],
      [
        "?? with a throwing function",
        'export const token = process.env.SANITY_API_READ_TOKEN ?? (() => { throw new Error("x"); })();',
      ],
      [
        "|| with a throw helper",
        "export const token = process.env.STORYBLOK_ACCESS_TOKEN || throwMissing('x');",
      ],
    ];
    it.each(cases)("%s", async (_name, code) => {
      const out = await flagged(code);
      expect(out, code).toHaveLength(1);
    });
  });

  describe("what it leaves alone", () => {
    const quiet: [string, string, string?][] = [
      [
        "a throw inside a function",
        'export function f() { if (!process.env.SANITY_API_READ_TOKEN) throw new Error("x"); }',
      ],
      [
        "a throw in a block",
        'export const f = () => {\n  const t = process.env.SANITY_API_READ_TOKEN;\n  if (!t) throw new Error("x");\n};',
      ],
      [
        "a top-level if with no throw",
        "if (!process.env.SANITY_API_READ_TOKEN) console.warn('no token');",
      ],
      ["a throw about something else", 'if (!process.env.NODE_ENV) throw new Error("x");'],
      [
        "a variable that is not a token",
        'if (!process.env.SANITY_PROJECT_ID) throw new Error("x");',
      ],
      [
        "a NEXT_PUBLIC_ name (cms-token-in-client-code)",
        'if (!process.env.NEXT_PUBLIC_SANITY_API_TOKEN) throw new Error("x");',
      ],
      [
        "a script",
        'if (!process.env.SANITY_API_WRITE_TOKEN) throw new Error("x");',
        "scripts/import.ts",
      ],
      [
        "a seed file",
        'if (!process.env.SANITY_API_WRITE_TOKEN) throw new Error("x");',
        "seed/menu.ts",
      ],
      [
        "a config file",
        'if (!process.env.SANITY_API_WRITE_TOKEN) throw new Error("x");',
        "sanity.config.ts",
      ],
      [
        "a comment",
        '// if (!process.env.SANITY_API_WRITE_TOKEN) throw new Error("x");\nexport {};',
      ],
    ];
    it.each(quiet)("%s", async (_name, code, path) => {
      expect(await flagged(code, path), code).toEqual([]);
    });
  });

  describe("not sure is not a pass", () => {
    it("no source is could-not-check", async () => {
      const result = await runOne(ID, treeOf({}));
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck.map((c) => c.id)).toEqual([ID]);
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
