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

const ID = "form-validation-in-client-bundle";
const SCHEMA =
  'import { z } from "zod";\nexport const enquirySchema = z.object({ name: z.string() });\n';
const client = (body: string, imp = 'import { enquirySchema } from "@/lib/schema";'): string =>
  `"use client";\n${imp}\n${body}\n`;
const run = (files: Record<string, string>) =>
  runOne(ID, treeOf({ "lib/schema.ts": SCHEMA, ...files }));
const flagged = async (files: Record<string, string>) =>
  (await run(files)).findings.map((f) => f.evidence);

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the client form that loads zod through its schema and reads only field names", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(spots(result)).toEqual(["components/EnquiryForm.tsx:3"]);
      expect(result.findings[0]).toMatchObject({
        checkId: ID,
        severity: "low",
        evidence:
          "components/EnquiryForm.tsx:3: this client component imports lib/enquiry-schema.ts, which loads zod, and only reads field names from it.",
      });
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the client form that gets its field names from a plain list", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("what it finds", () => {
    it.each([
      [".shape", "const f = Object.keys(enquirySchema.shape);"],
      [".keyof()", "const f = enquirySchema.keyof().options;"],
      [
        "a shape member and a keyof",
        "const a = enquirySchema.shape.name;\nconst b = enquirySchema.keyof();",
      ],
      ["a spread of the shape", "const f = { ...enquirySchema.shape };"],
    ])("a client file that uses only %s", async (_n, body) => {
      expect(await flagged({ "components/Form.tsx": client(body) })).toHaveLength(1);
    });

    it("finds the library imported by the client file itself", async () => {
      const out = await flagged({
        "components/Form.tsx":
          '"use client";\nimport * as v from "valibot";\nconst s = v.object({ a: v.string() });\nexport const f = Object.keys(s.entries);\n',
      });
      expect(out).toEqual([
        "components/Form.tsx:2: this client component loads valibot and only reads field names from a schema it defines.",
      ]);
    });

    it.each(["yup", "joi", "superstruct", "arktype", "zod/mini"])("names %s", async (lib) => {
      const out = await flagged({
        "lib/schema.ts": `import * as z from "${lib}";\nexport const enquirySchema = z.object({});\n`,
        "components/Form.tsx": client("const f = Object.keys(enquirySchema.shape);"),
      });
      expect(out[0]).toContain(`loads ${lib}`);
    });
  });

  describe("what it leaves alone", () => {
    it.each([
      ["a parse", "const r = enquirySchema.safeParse({});"],
      ["a parse call", "const r = enquirySchema.parse({});"],
      ["parseAsync", "const r = await enquirySchema.parseAsync({});"],
      ["a resolver", "const o = { resolver: zodResolver(enquirySchema) };"],
      ["a validate", "const r = enquirySchema.validateSync({});"],
      [
        "names and a parse together",
        "const f = enquirySchema.shape;\nconst r = enquirySchema.safeParse({});",
      ],
    ])("a client file that validates with it: %s", async (_n, body) => {
      expect(await flagged({ "components/Form.tsx": client(body) })).toEqual([]);
    });

    it("leaves a file that is not a client component", async () => {
      const server =
        'import { enquirySchema } from "@/lib/schema";\nexport const f = Object.keys(enquirySchema.shape);\n';
      expect(await flagged({ "app/page.tsx": server })).toEqual([]);
    });

    it("leaves a type-only import and a use of the schema only as a type", async () => {
      expect(
        await flagged({
          "components/Form.tsx": client(
            "export type Enquiry = z.infer<typeof enquirySchema>;",
            'import type { enquirySchema } from "@/lib/schema";',
          ),
        }),
      ).toEqual([]);
      expect(
        await flagged({ "components/Form.tsx": client("export type E = typeof enquirySchema;") }),
      ).toEqual([]);
    });

    it("leaves an import from a module that does not load a validation library", async () => {
      expect(
        await flagged({
          "lib/schema.ts": "export const enquirySchema = { shape: {} };\n",
          "components/Form.tsx": client("const f = Object.keys(enquirySchema.shape);"),
        }),
      ).toEqual([]);
    });

    it("does not read a comment", async () => {
      expect(
        await flagged({
          "components/Form.tsx": client("// Object.keys(enquirySchema.shape)\nconst a = 1;"),
        }),
      ).toEqual([]);
    });
  });

  describe("not sure is not a pass", () => {
    it("a schema used in a way Gaugeline cannot read is could-not-check", async () => {
      const result = await run({
        "components/Form.tsx": client("const copy = enquirySchema;\nexport { copy };"),
      });
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck.map((c) => c.id)).toEqual([ID]);
    });

    it("a folder with no source is could-not-check, and so is one with a file left out", async () => {
      expect((await runOne(ID, treeOf({}))).passed).toEqual([]);
      const left = await runOne(
        ID,
        treeOf({ "a.ts": "export {};" }, { skipped: new Map([["b.tsx", "too-large"]]) }),
      );
      expect(left.passed).toEqual([]);
    });

    it("a folder with code and no client component passes", async () => {
      expect((await runOne(ID, treeOf({ "a.ts": "export {};" }))).passed).toEqual([ID]);
    });
  });

  it("names files and lines and never prints a field name", async () => {
    const result = await run({
      "lib/schema.ts":
        'import { z } from "zod";\nexport const enquirySchema = z.object({ sentinelFieldZ: z.string() });\n',
      "components/Form.tsx": client("const f = Object.keys(enquirySchema.shape.sentinelFieldZ);"),
    });
    expectNoneOf(result, ["sentinelFieldZ"]);
  });
});
