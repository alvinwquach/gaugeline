import { resultSchema, type Transport } from "@gaugeline/core";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { HELP } from "../help.js";
import { EXIT, main } from "../main.js";

/** The invented Marlow Physiotherapy repository: six queries, four planted unused fields, one that escapes. */
const repo = fileURLToPath(new URL("../../../fixtures/repo-unused/", import.meta.url));
const NOW = new Date("2026-11-10T12:00:00Z");

/** A transport that fails the test if anything is requested: this command asks nothing. */
const never: Transport = () => {
  throw new Error("gaugeline query --unused made a request");
};

async function unused(
  argv: string[],
  env: Record<string, string | undefined> = {},
  cwd: string = repo,
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ["query", ...argv],
    {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env,
    },
    { cwd, now: () => NOW, fetcher: { transport: never, timeoutMs: 5000 } },
  );
  return { code, out: out.join(""), err: err.join("") };
}

const EXPECTED = [
  "Read 6 queries in 12 files and followed 5 results through the code. Nothing was sent, and no key or environment variable was read.",
  "",
  "Could not follow 1 query (none of their fields are reported):",
  "  ./src/lib/queries.ts:45  its result is passed to JSON.stringify, which Gaugeline cannot read into (./src/app/api/search-index/route.ts:6)",
  "",
  "! summary is fetched and never used",
  "    summary \u00B7 ./src/lib/queries.ts:3",
  "! practitioner.bio is fetched and never used",
  "    practitioner.bio \u00B7 ./src/lib/queries.ts:13",
  "! instagram is fetched and never used",
  "    instagram \u00B7 ./src/lib/queries.ts:23",
  "! qualifications is fetched and never used",
  "    qualifications \u00B7 ./src/lib/queries.ts:32",
  "",
  "4 to look at, none to fix first.",
].join("\n");

describe("gaugeline query --unused: e2e", () => {
  it("prints four findings and one could-not-follow for the invented clinic, with an empty environment", async () => {
    const r = await unused(["./src", "--unused"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe("");
    expect(r.out.trimEnd()).toBe(EXPECTED);
  });

  it("prints the same with every Sanity setting present and a token in the environment, and never requests anything", async () => {
    // Key-shaped values are put together at run time: GitHub push protection rejects literals.
    const token = ["sk", "viewer", "Marlow0123456789abcdef"].join("_");
    const r = await unused(["./src", "--unused"], {
      SANITY_PROJECT_ID: "marlowphysio",
      SANITY_DATASET: "production",
      SANITY_TOKEN: token,
      GRAPHQL_TOKEN: token,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.trimEnd()).toBe(EXPECTED);
    expect(r.out + r.err).not.toContain(token);
  });

  it("--json prints the usual result: four findings with their source, and the query it could not follow", async () => {
    const r = await unused([".", "--unused", "--json"]);
    expect(r.code).toBe(EXIT.ok);
    const result = resultSchema.parse(JSON.parse(r.out));
    expect(result.findings.map((f) => [f.checkId, f.severity, f.source])).toEqual([
      ["query-field-unused", "medium", { file: "src/lib/queries.ts", line: 3 }],
      ["query-field-unused", "medium", { file: "src/lib/queries.ts", line: 13 }],
      ["query-field-unused", "medium", { file: "src/lib/queries.ts", line: 23 }],
      ["query-field-unused", "medium", { file: "src/lib/queries.ts", line: 32 }],
    ]);
    expect(result.couldNotCheck).toEqual([
      {
        id: "query-field-unused",
        reason: expect.stringContaining("JSON.stringify"),
        url: "src/lib/queries.ts:45",
      },
    ]);
    expect(result.passed).toEqual([]);
  });

  it("--ci exits 0: a field nobody reads is a warning, not a fix-first finding", async () => {
    expect((await unused(["./src", "--unused", "--ci"])).code).toBe(EXIT.ok);
  });

  it("says so, and exits 0, for a folder with no queries", async () => {
    const r = await unused(["./src/components", "--unused"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("No GROQ or GraphQL queries found under ./src/components.");
  });

  it("is exit 2 for a folder that does not exist", async () => {
    const r = await unused(["./nowhere", "--unused"]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("does not exist");
  });
});

describe("gaugeline query --unused: the flag", () => {
  const parse = (argv: string[]) => parseCliArgs(["query", ...argv]);

  it("is parsed as its own run, with the folder", () => {
    expect(parse(["./src", "--unused"])).toMatchObject({
      kind: "query",
      dir: "./src",
      unused: true,
      dupes: false,
      mutations: false,
    });
  });

  it("needs one folder, and refuses to be combined with the other runs or --schema", () => {
    for (const argv of [
      ["--unused"],
      ["./src", "--unused", "--graphql"],
      ["./src", "--unused", "--dupes"],
      ["./src", "--unused", "--mutations"],
      ["./src", "--unused", "--schema", "schema.json"],
      ["./src", "--unused", "--suggest", "--type", "post"],
      ["--unused", "--page", "--type", "post", "--out", "./x"],
    ])
      expect(parse(argv).kind, argv.join(" ")).toBe("error");
  });

  it("is in --help and in the flag list, for query only", () => {
    expect(HELP.query).toContain("--unused");
    const flag = FLAGS.find((f) => f.name === "unused");
    expect(flag?.commands).toEqual(["query"]);
  });
});
