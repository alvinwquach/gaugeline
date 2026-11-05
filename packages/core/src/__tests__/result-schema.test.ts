import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import * as z from "zod";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUMP_MESSAGE,
  buildSchemaText,
  checkSchemaDir,
  sha256,
} from "../../../../scripts/lib/schema.js";
import { defineCheck, type Finding } from "../model.js";
import { RESULT_SCHEMA_VERSION, buildResult, findingSchema, resultSchema } from "../result.js";
import { runCheckList } from "../runner.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const schemaDir = join(repoRoot, "packages/core/schema");
const committed = readFileSync(join(schemaDir, "result.v1.json"), "utf8");

function compile() {
  const warnings: unknown[] = [];
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    logger: {
      log: () => {},
      warn: (...a: unknown[]) => warnings.push(a),
      error: (...a: unknown[]) => warnings.push(a),
    },
  });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(committed) as object);
  return { validate, warnings };
}

const finding: Finding = {
  checkId: "h1-missing",
  severity: "medium",
  title: "The page has no main heading",
  evidence: "0 <h1> elements",
  url: "https://shop.example/",
};
const minimal = {
  schema: 1,
  url: "https://shop.example/",
  startedAt: "2026-01-02T03:04:05.000Z",
  findings: [finding],
  passed: ["title-missing"],
  failed: [],
};

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("result schema: unit", () => {
  it("build-schema output is identical across two runs (byte compare)", () => {
    expect(buildSchemaText(resultSchema, 1)).toBe(buildSchemaText(resultSchema, 1));
    expect(buildSchemaText(resultSchema, 1)).toBe(committed);
  });

  it("key order in the zod object does not change the output", () => {
    const shuffledFinding = z
      .object({
        url: z.string(),
        source: z
          .object({ line: z.number().int().nonnegative(), file: z.string() })
          .strict()
          .optional(),
        evidence: z.string(),
        title: z.string(),
        severity: z.enum(["high", "medium", "low"]),
        checkId: z.string().min(1),
      })
      .strict();
    const shuffled = z
      .object({
        failed: z.array(z.string()),
        passed: z.array(z.string()),
        findings: z.array(shuffledFinding),
        startedAt: z.iso.datetime({ offset: true }),
        url: z.string(),
        schema: z.literal(1),
      })
      .strict();
    expect(buildSchemaText(shuffled, 1)).toBe(buildSchemaText(resultSchema, 1));
  });

  it("schema/result.v1.json is valid JSON Schema: Ajv compiles it in strict mode with no warnings", () => {
    const { warnings } = compile();
    expect(warnings).toEqual([]);
    const parsed = JSON.parse(committed) as Record<string, unknown>;
    expect(parsed.$id).toBe("https://gaugeline.dev/schema/result.v1.json");
    expect(parsed.title).toBe("Gaugeline result v1");
    expect(parsed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("a minimal valid Result validates; schema: 2 and a finding missing severity are rejected", () => {
    const { validate } = compile();
    expect(validate(minimal), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...minimal, schema: 2 })).toBe(false);
    const { severity: _s, ...noSeverity } = finding;
    expect(validate({ ...minimal, findings: [noSeverity] })).toBe(false);
    // zod agrees with the published file
    expect(resultSchema.safeParse(minimal).success).toBe(true);
    expect(resultSchema.safeParse({ ...minimal, schema: 2 }).success).toBe(false);
  });
});

describe("result schema: integration", () => {
  it("schema:check exits 0 on the committed tree", () => {
    const tsx = join(repoRoot, "node_modules/tsx/dist/cli.mjs");
    const r = spawnSync(process.execPath, [tsx, "scripts/build-schema.ts", "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("adding an optional field to a copy of resultSchema makes the hash guard fail with the bump message", () => {
    const changed = resultSchema.extend({ note: z.string().optional() });
    const check = checkSchemaDir(schemaDir, 1, buildSchemaText(changed, 1));
    expect(check.ok).toBe(false);
    expect(check.problems).toContain(BUMP_MESSAGE);
  });

  it("after bumping to v2 and adding result.v2.json plus its hash, the guard passes and v1 is untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-schema-"));
    temps.push(dir);
    copyFileSync(join(schemaDir, "result.v1.json"), join(dir, "result.v1.json"));
    const v2Schema = resultSchema.extend({ schema: z.literal(2), note: z.string().optional() });
    const v2 = buildSchemaText(v2Schema, 2);
    const versions = JSON.parse(readFileSync(join(schemaDir, "versions.json"), "utf8")) as Record<
      string,
      string
    >;
    writeFileSync(join(dir, "result.v2.json"), v2);
    writeFileSync(join(dir, "versions.json"), JSON.stringify({ ...versions, "2": sha256(v2) }));
    expect(checkSchemaDir(dir, 2, v2)).toEqual({ ok: true, problems: [] });
    expect(checkSchemaDir(dir, 1, committed)).toEqual({ ok: true, problems: [] });
    expect(readFileSync(join(dir, "result.v1.json"), "utf8")).toBe(committed);
  });
});

describe("result schema: end to end through the runner", () => {
  // The CLI gains --json in G06, which spawns the bin and validates its stdout against this file.
  const run = async (checks: Parameters<typeof runCheckList<string>>[0]) => {
    const out = await runCheckList(checks, "page");
    return buildResult({ url: "https://shop.example/", startedAt: new Date(0), ...out });
  };
  const base = {
    area: "Visitors",
    severity: "low",
    title: "t",
    what: "w",
    why: "y",
    fix: "f",
    tech: "t",
  } as const;

  it("a run with zero findings validates", async () => {
    const { validate } = compile();
    const result = await run([defineCheck<string>({ ...base, id: "quiet", run: () => [] })]);
    expect(result.findings).toEqual([]);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  });

  it("a run where one check failed to execute validates and failed is non-empty", async () => {
    const { validate } = compile();
    const result = await run([
      defineCheck<string>({
        ...base,
        id: "broken",
        run: () => {
          throw new Error("x");
        },
      }),
      defineCheck<string>({ ...base, id: "finds", run: () => [{ ...finding, checkId: "finds" }] }),
    ]);
    expect(result.failed).toEqual(["broken"]);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("result schema: edge cases", () => {
  it("startedAt without a timezone offset is rejected (format date-time)", () => {
    const { validate } = compile();
    expect(validate({ ...minimal, startedAt: "2026-01-02T03:04:05" })).toBe(false);
    expect(validate({ ...minimal, startedAt: "2026-01-02T03:04:05+02:00" })).toBe(true);
    expect(resultSchema.safeParse({ ...minimal, startedAt: "2026-01-02T03:04:05" }).success).toBe(
      false,
    );
  });

  it("findings: [] is valid; findings missing entirely is not", () => {
    const { validate } = compile();
    expect(validate({ ...minimal, findings: [] })).toBe(true);
    const { findings: _f, ...noFindings } = minimal;
    expect(validate(noFindings)).toBe(false);
  });

  it("an unknown top-level key is rejected (additionalProperties false) so typos surface", () => {
    const { validate } = compile();
    expect(validate({ ...minimal, pased: [] })).toBe(false);
    expect(resultSchema.safeParse({ ...minimal, pased: [] }).success).toBe(false);
  });

  it("CRLF checkout: line endings are normalised before hashing", () => {
    expect(sha256(committed.replace(/\n/g, "\r\n"))).toBe(sha256(committed));
    expect(checkSchemaDir(schemaDir, 1, committed.replace(/\n/g, "\r\n")).ok).toBe(true);
  });

  it("the Finding has no evidence union yet: evidence is a plain string in the published schema", () => {
    // G02 defines evidence as a string; if a union is introduced, each variant must appear under oneOf.
    const parsed = JSON.parse(committed) as {
      properties: { findings: { items: { properties: { evidence: unknown } } } };
    };
    expect(parsed.properties.findings.items.properties.evidence).toEqual({ type: "string" });
    expect(findingSchema.shape.evidence).toBeDefined();
    expect(RESULT_SCHEMA_VERSION).toBe(1);
  });
});
