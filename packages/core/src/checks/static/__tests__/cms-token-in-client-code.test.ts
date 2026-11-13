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

const ID = "cms-token-in-client-code";

// Built at run time: a literal shaped like a key is refused by the repository's secret scanning.
const FAKE = ["sk", "fakeFakeFakeFake0123456789", "FakeFake"].join("");

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the folder where a client component imports the token module, and a NEXT_PUBLIC_ token is read", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(result.findings.length).toBeGreaterThan(0);
      expect(spots(result)).toEqual(["lib/preview.ts:1", "lib/sanity.ts:4"]);
      expect(result.findings[0]?.evidence).toContain("NEXT_PUBLIC_SANITY_WRITE_TOKEN");
      expect(result.findings[1]?.evidence).toContain(
        "components/MenuFilter.tsx (a client component) imports it",
      );
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the folder with server-only on the token module and props to the client", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("unit", () => {
    const token = "export const t = process.env.SANITY_API_READ_TOKEN;\n";
    it("follows imports through other modules and the @/ shortcut", async () => {
      const result = await runOne(
        ID,
        treeOf({
          "src/lib/token.ts": token,
          "src/lib/client.ts": 'import { t } from "./token";\nexport const c = t;\n',
          "src/components/Gallery.tsx":
            '"use client";\nimport { c } from "@/lib/client";\nexport const G = () => c;\n',
        }),
      );
      expect(spots(result)).toEqual(["src/lib/token.ts:1"]);
      expect(result.findings[0]?.evidence).toContain("src/components/Gallery.tsx");
    });

    it("flags a module that is itself marked use client", async () => {
      const result = await runOne(ID, treeOf({ "a.tsx": `"use client";\n${token}` }));
      expect(result.findings[0]?.evidence).toContain('marked "use client"');
    });

    it("reads bracketed and destructured reads", async () => {
      for (const read of [
        'process.env["SANITY_API_WRITE_TOKEN"]',
        "process.env.SANITY_API_WRITE_TOKEN",
      ]) {
        const r = await runOne(ID, treeOf({ "a.tsx": `"use client";\nexport const t = ${read};` }));
        expect(r.findings.length).toBeGreaterThan(0);
      }
      const r = await runOne(
        ID,
        treeOf({
          "a.tsx":
            '"use client";\nconst { SANITY_API_READ_TOKEN: t } = process.env;\nexport { t };',
        }),
      );
      expect(r.findings.length).toBeGreaterThan(0);
    });

    it("does not flag a token module no client component reaches", async () => {
      const result = await runOne(
        ID,
        treeOf({
          "lib/token.ts": token,
          "app/api/route.ts": 'import { t } from "../../lib/token";\nexport const GET = () => t;\n',
        }),
      );
      expect(result.passed).toEqual([ID]);
    });

    it("does not flag server-only modules, in either quote style or as require", async () => {
      for (const guard of [
        'import "server-only";',
        "import 'server-only';",
        'require("server-only");',
      ]) {
        const result = await runOne(
          ID,
          treeOf({
            "lib/token.ts": `${guard}\n${token}`,
            "c.tsx": '"use client";\nimport { t } from "./lib/token";\nexport const c = t;',
          }),
        );
        expect(result.passed, guard).toEqual([ID]);
      }
    });

    it("ignores a type-only import, a package import and a comment", async () => {
      const result = await runOne(
        ID,
        treeOf({
          "lib/token.ts": token,
          "c.tsx":
            '"use client";\nimport type { t } from "./lib/token";\nimport { createClient } from "next-sanity";\n// process.env.NEXT_PUBLIC_SANITY_API_TOKEN\nexport const c = createClient;',
        }),
      );
      expect(result.passed).toEqual([ID]);
    });

    it("does not flag public values that are not tokens", async () => {
      const result = await runOne(
        ID,
        treeOf({
          "a.tsx":
            '"use client";\nexport const p = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID + process.env.NEXT_PUBLIC_SANITY_DATASET + process.env.STRIPE_SECRET_KEY;',
        }),
      );
      expect(result.passed).toEqual([ID]);
    });

    it("ignores test files, which hold invented tokens on purpose", async () => {
      const result = await runOne(
        ID,
        treeOf({
          "lib/x.test.ts": "const t = process.env.NEXT_PUBLIC_SANITY_API_TOKEN;",
          "a.ts": "export {};",
        }),
      );
      expect(result.passed).toEqual([ID]);
    });

    it("reports a NEXT_PUBLIC_ variable once per file, wherever the file is", async () => {
      const result = await runOne(
        ID,
        treeOf({
          "lib/a.ts":
            "export const a = process.env.NEXT_PUBLIC_CONTENTFUL_ACCESS_TOKEN;\nexport const b = process.env.NEXT_PUBLIC_CONTENTFUL_ACCESS_TOKEN;",
        }),
      );
      expect(spots(result)).toEqual(["lib/a.ts:1"]);
    });
  });

  describe("not sure is not a pass", () => {
    it("a folder with no source file is could-not-check", async () => {
      const result = await runOne(ID, treeOf({ "README.md": "# hello" }));
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck.map((c) => c.id)).toEqual([ID]);
      expect(result.couldNotCheck[0]?.reason).toMatch(/no source file/);
    });

    it("a source file left out (too large) is could-not-check, never a pass", async () => {
      const result = await runOne(
        ID,
        treeOf({ "a.ts": "export {};" }, { skipped: new Map([["big.ts", "too-large"]]) }),
      );
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck[0]?.reason).toMatch(/could not be read/);
    });

    it("a truncated folder never passes (the runner's rule)", async () => {
      const result = await runOne(ID, treeOf({ "a.ts": "export {};" }, { truncated: true }));
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck.map((c) => c.id)).toEqual([ID]);
    });

    it("a finding stands even when part of the folder was not read", async () => {
      const result = await runOne(
        ID,
        treeOf(
          { "a.tsx": '"use client";\nexport const t = process.env.NEXT_PUBLIC_SANITY_API_TOKEN;' },
          { skipped: new Map([["big.ts", "too-large"]]) },
        ),
      );
      expect(result.findings.length).toBeGreaterThan(0);
    });
  });

  it("never prints a token it finds, in JSON, SARIF or the report", async () => {
    const result = await runOne(
      ID,
      treeOf({
        "lib/token.ts": `const t = process.env.SANITY_API_READ_TOKEN ?? "${FAKE}";\nexport const x = t;\nexport const y = process.env.NEXT_PUBLIC_SANITY_API_TOKEN ?? "${FAKE}";`,
        "c.tsx": '"use client";\nimport { x } from "./lib/token";\nexport const c = x;',
      }),
    );
    expectNoneOf(result, [FAKE]);
  });
});
