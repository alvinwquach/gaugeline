import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { buildSchemaText, checkSchemaDir, sha256 } from "../../../../scripts/lib/schema.js";
import type { Finding } from "../model.js";
import { RESULT_SCHEMA_VERSION, buildResult, resultSchema } from "../result.js";
import {
  RESULT_SCHEMA_VERSION_3,
  SELECTABLE_RESULT_SCHEMAS,
  buildResultV3,
  parseResultV3,
  resultSchemaV3,
} from "../result-v3.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const schemaDir = join(repoRoot, "packages/core/schema");
const read = (name: string) => readFileSync(join(schemaDir, name), "utf8");

const finding: Finding = {
  checkId: "og-image-missing",
  severity: "low",
  title: "Shared links have no picture",
  evidence: "no og:image on https://fernhill.example/",
  url: "https://fernhill.example/",
};
const entry = { id: "og-image-missing", until: "2026-12-31", reason: "Photo shoot is Friday" };
const run = {
  url: "https://fernhill.example/",
  startedAt: new Date("2026-11-13T12:00:00Z"),
  findings: [] as Finding[],
  passed: ["title-missing"],
  failed: [] as string[],
};

function validator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(read("result.v3.json")) as object);
}

describe("result schema 3: unit", () => {
  it("the default schema number is still 2, and 3 is selectable", () => {
    expect(RESULT_SCHEMA_VERSION).toBe(2);
    expect(RESULT_SCHEMA_VERSION_3).toBe(3);
    expect([...SELECTABLE_RESULT_SCHEMAS]).toEqual([2, 3]);
  });

  it("buildResultV3 is the schema 2 result with schema 3 and four extra lists", () => {
    const v2 = buildResult(run);
    const v3 = buildResultV3({ ...run, suppressed: [{ finding, entry }], baselined: [finding] });
    const { schema: _a, ...rest2 } = v2;
    const { schema, suppressed, expiredSuppressions, unmatchedSuppressions, baselined, ...rest3 } =
      v3;
    expect(schema).toBe(3);
    expect(rest3).toEqual(rest2);
    expect(suppressed).toEqual([{ finding, by: entry }]);
    expect(expiredSuppressions).toEqual([]);
    expect(unmatchedSuppressions).toEqual([]);
    expect(baselined).toEqual([finding]);
  });

  it("with nothing hidden every extra list is present and empty", () => {
    const v3 = buildResultV3(run);
    expect(v3.suppressed).toEqual([]);
    expect(v3.expiredSuppressions).toEqual([]);
    expect(v3.unmatchedSuppressions).toEqual([]);
    expect(v3.baselined).toEqual([]);
    expect(parseResultV3(v3)).toEqual(v3);
  });

  it("an entry keeps its address when it has one, and the reason is redacted", () => {
    // Built at run time so no key-shaped text sits in the repository.
    const body = "q7Zr".repeat(6);
    const key = ["sk", "live", body].join("_");
    const v3 = buildResultV3({
      ...run,
      expired: [{ ...entry, url: "/menu", reason: `key ${key} is rotated` }],
    });
    expect(v3.expiredSuppressions[0]?.url).toBe("/menu");
    expect(v3.expiredSuppressions[0]?.reason).not.toContain(body);
  });

  it("the schema 2 parser refuses a schema 3 result, and the schema 3 parser refuses schema 2", () => {
    const v3 = buildResultV3(run);
    expect(resultSchema.safeParse(v3).success).toBe(false);
    expect(resultSchemaV3.safeParse(buildResult(run)).success).toBe(false);
    expect(resultSchemaV3.safeParse({ ...v3, extra: 1 }).success).toBe(false);
  });
});

describe("result schema 3: the published file", () => {
  it("result.v3.json is what the zod definition builds, and Ajv compiles it in strict mode", () => {
    expect(buildSchemaText(resultSchemaV3, RESULT_SCHEMA_VERSION_3)).toBe(read("result.v3.json"));
    expect(() => validator()).not.toThrow();
    const parsed = JSON.parse(read("result.v3.json")) as Record<string, unknown>;
    expect(parsed.$id).toBe("https://gaugeline.dev/schema/result.v3.json");
    expect(parsed.title).toBe("Gaugeline result v3");
  });

  it("real builder output validates, with and without anything hidden; a schema 2 result does not", () => {
    const validate = validator();
    for (const v3 of [
      buildResultV3(run),
      buildResultV3({
        ...run,
        findings: [finding],
        suppressed: [{ finding, entry: { ...entry, url: "https://fernhill.example/" } }],
        expired: [entry],
        unmatched: [{ id: "typo-id", until: "2026-12-31", reason: "x" }],
        baselined: [finding],
      }),
    ])
      expect(validate(v3), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(buildResult(run))).toBe(false);
    expect(validate({ ...buildResultV3(run), suppressed: [{ finding }] })).toBe(false);
    expect(validate({ ...buildResultV3(run), until: "2026-12-31" })).toBe(false);
  });

  it("schema:check passes, and the hash guard fails for a changed shape", () => {
    const tsx = join(repoRoot, "node_modules/tsx/dist/cli.mjs");
    const r = spawnSync(process.execPath, [tsx, "scripts/build-schema.ts", "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const changed = resultSchemaV3.extend({ note: resultSchemaV3.shape.url.optional() });
    expect(checkSchemaDir(schemaDir, 3, buildSchemaText(changed, 3)).ok).toBe(false);
  });
});

describe("schemas 1 and 2 are untouched", () => {
  // Golden hashes: these never change. A new shape is a new file, never an edit of these.
  it("result.v1.json and result.v2.json hash to the values published with them", () => {
    expect(sha256(read("result.v1.json"))).toBe(
      "95ac58cd1b782e7217747510441263c3c395aa50923b2809775ece636eb3326f",
    );
    expect(sha256(read("result.v2.json"))).toBe(
      "ca4ea05166ae50fed2f27a25a19d12945e7980537d295c69b7adbe7872fa5878",
    );
    const versions = JSON.parse(read("versions.json")) as Record<string, string>;
    expect(versions["1"]).toBe(sha256(read("result.v1.json")));
    expect(versions["2"]).toBe(sha256(read("result.v2.json")));
  });

  it("a schema 2 result has exactly its eight keys, whatever was hidden", () => {
    const keys = Object.keys(buildResult({ ...run, findings: [finding] })).sort();
    expect(keys).toEqual(
      [
        "couldNotCheck",
        "failed",
        "findings",
        "passed",
        "sampled",
        "schema",
        "startedAt",
        "url",
      ].sort(),
    );
    expect(resultSchema.shape).not.toHaveProperty("suppressed");
  });
});
