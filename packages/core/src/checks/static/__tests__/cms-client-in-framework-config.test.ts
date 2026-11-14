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

const ID = "cms-client-in-framework-config";
const flagged = async (files: Record<string, string>) =>
  (await runOne(ID, treeOf(files))).findings.map((f) => f.evidence);

const IMPORT = 'import { createClient } from "@sanity/client";\n';

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the config file that makes a content client when it loads", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(spots(result)).toEqual(["next.config.mjs:3"]);
      expect(result.findings[0]).toMatchObject({
        checkId: ID,
        severity: "low",
        evidence: "next.config.mjs:3: a content client is created when this config file loads.",
      });
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the config file with no client, and the client made in a function elsewhere", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("what it finds", () => {
    it.each([
      ["next.config.ts", "next.config.ts"],
      ["nuxt.config.ts", "nuxt.config.ts"],
      ["astro.config.mjs", "astro.config.mjs"],
      ["svelte.config.js", "svelte.config.js"],
      ["vite.config.ts", "vite.config.ts"],
      ["a config in a sub folder", "web/next.config.js"],
    ])("a client at the top of %s", async (_n, path) => {
      expect(
        await flagged({ [path]: `${IMPORT}const c = createClient({});\nexport default {};` }),
      ).toHaveLength(1);
    });

    it.each([
      ["contentful", 'import { createClient } from "contentful";', "createClient({ space: 'x' })"],
      [
        "a directus client",
        'import { createDirectus } from "@directus/sdk";',
        "createDirectus('https://cms.example')",
      ],
      [
        "a prismic client",
        'import * as prismic from "@prismicio/client";',
        "prismic.createClient('x')",
      ],
      ["a require", 'const { createClient } = require("@sanity/client");', "createClient({})"],
    ])("%s", async (_n, imp, call) => {
      expect(
        await flagged({ "next.config.js": `${imp}\nconst c = ${call};\nmodule.exports = {};` }),
      ).toHaveLength(1);
    });

    it("finds a client inside the exported object that is built when the file loads", async () => {
      const out = await flagged({
        "next.config.mjs": `${IMPORT}export default {\n  env: { n: createClient({}).config().dataset },\n};`,
      });
      expect(out).toEqual([
        "next.config.mjs:3: a content client is created when this config file loads.",
      ]);
    });

    it("finds a client made at the top of a local module the config imports", async () => {
      const out = await flagged({
        "next.config.ts": 'import { client } from "./lib/sanity";\nexport default {};',
        "lib/sanity.ts": `${IMPORT}export const client = createClient({});`,
      });
      expect(out).toEqual([
        "next.config.ts:1: this config file imports lib/sanity.ts, which creates a content client when it loads.",
      ]);
    });
  });

  describe("what it leaves alone", () => {
    it.each([
      [
        "a client made inside a function",
        `${IMPORT}export default { async redirects() { const c = createClient({}); return []; } };`,
      ],
      [
        "a client made in an arrow function",
        `${IMPORT}const make = () => createClient({});\nexport default { make };`,
      ],
      [
        "a client made inside an async method with a return type",
        `${IMPORT}export default { async redirects(): Promise<[]> { const c = createClient({}); return []; } };`,
      ],
      [
        "a dynamic import",
        'export default { async redirects() { const { createClient } = await import("@sanity/client"); createClient({}); return []; } };',
      ],
      [
        "a createClient that is not a content system",
        'import { createClient } from "@supabase/supabase-js";\nconst c = createClient("u", "k");\nexport default {};',
      ],
      ["a call in a comment", `${IMPORT}// const c = createClient({});\nexport default {};`],
      ["a call named in a string", `${IMPORT}export default { note: "createClient(" };`],
    ])("%s", async (_n, code) => {
      expect(await flagged({ "next.config.mjs": code })).toEqual([]);
    });

    it("does not read a file that is not a framework config, or a test", async () => {
      expect(
        await flagged({ "lib/sanity.ts": `${IMPORT}export const c = createClient({});` }),
      ).toEqual([]);
      expect(
        await flagged({ "sanity.config.ts": `${IMPORT}export const c = createClient({});` }),
      ).toEqual([]);
      expect(
        await flagged({
          "tests/next.config.test.ts": `${IMPORT}export const c = createClient({});`,
        }),
      ).toEqual([]);
    });

    it("does not follow a package, or a module that makes its client in a function", async () => {
      expect(
        await flagged({
          "next.config.ts":
            'import { client } from "some-package";\nimport { get } from "./lib/sanity";\nexport default {};',
          "lib/sanity.ts": `${IMPORT}export const get = () => createClient({});`,
        }),
      ).toEqual([]);
    });
  });

  describe("not sure is not a pass", () => {
    it("a folder with no source is could-not-check, and so is one with a file left out", async () => {
      const none = await runOne(ID, treeOf({}));
      expect(none.passed).toEqual([]);
      expect(none.couldNotCheck.map((c) => c.id)).toEqual([ID]);
      const left = await runOne(
        ID,
        treeOf(
          { "next.config.mjs": "export default {};" },
          { skipped: new Map([["lib/big.ts", "too-large"]]) },
        ),
      );
      expect(left.passed).toEqual([]);
    });

    it("a config that imports a local module that cannot be found is not read as a pass or a finding", async () => {
      const result = await runOne(
        ID,
        treeOf({ "next.config.ts": 'import { c } from "./lib/missing";\nexport default {};' }),
      );
      expect(result.findings).toEqual([]);
    });
  });

  it("names the file and the line, and never prints the project id or the dataset it reads", async () => {
    const result = await runOne(
      ID,
      treeOf({
        "next.config.mjs": `${IMPORT}const c = createClient({ projectId: "sentinel-project-0011", token: process.env.SANITY_API_READ_TOKEN });\nexport default {};`,
      }),
    );
    expectNoneOf(result, ["sentinel-project-0011", "SANITY_API_READ_TOKEN"]);
  });
});
