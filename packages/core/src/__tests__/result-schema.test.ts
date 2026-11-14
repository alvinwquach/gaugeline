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
const committed = readFileSync(join(schemaDir, `result.v${RESULT_SCHEMA_VERSION}.json`), "utf8");

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
  schema: RESULT_SCHEMA_VERSION,
  couldNotCheck: [],
  sampled: {},
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
    expect(buildSchemaText(resultSchema, RESULT_SCHEMA_VERSION)).toBe(
      buildSchemaText(resultSchema, RESULT_SCHEMA_VERSION),
    );
    expect(buildSchemaText(resultSchema, RESULT_SCHEMA_VERSION)).toBe(committed);
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
        sampled: z.record(
          z.string(),
          z
            .object({
              seen: z.number().int().nonnegative(),
              taken: z.number().int().nonnegative(),
              limit: z.number().int().nonnegative(),
            })
            .strict(),
        ),
        couldNotCheck: z.array(
          z.object({ url: z.string(), reason: z.string(), id: z.string() }).strict(),
        ),
        failed: z.array(z.string()),
        passed: z.array(z.string()),
        findings: z.array(shuffledFinding),
        startedAt: z.iso.datetime({ offset: true }),
        url: z.string(),
        schema: z.literal(RESULT_SCHEMA_VERSION),
      })
      .strict();
    expect(buildSchemaText(shuffled, RESULT_SCHEMA_VERSION)).toBe(
      buildSchemaText(resultSchema, RESULT_SCHEMA_VERSION),
    );
  });

  it("the current schema file is valid JSON Schema: Ajv compiles it in strict mode with no warnings", () => {
    const { warnings } = compile();
    expect(warnings).toEqual([]);
    const parsed = JSON.parse(committed) as Record<string, unknown>;
    expect(parsed.$id).toBe(`https://gaugeline.dev/schema/result.v${RESULT_SCHEMA_VERSION}.json`);
    expect(parsed.title).toBe(`Gaugeline result v${RESULT_SCHEMA_VERSION}`);
    expect(parsed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("a minimal valid Result validates; another schema number and a finding missing severity are rejected", () => {
    const { validate } = compile();
    expect(validate(minimal), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...minimal, schema: RESULT_SCHEMA_VERSION + 1 })).toBe(false);
    const { severity: _s, ...noSeverity } = finding;
    expect(validate({ ...minimal, findings: [noSeverity] })).toBe(false);
    // zod agrees with the published file
    expect(resultSchema.safeParse(minimal).success).toBe(true);
    expect(resultSchema.safeParse({ ...minimal, schema: RESULT_SCHEMA_VERSION + 1 }).success).toBe(
      false,
    );
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
    const check = checkSchemaDir(
      schemaDir,
      RESULT_SCHEMA_VERSION,
      buildSchemaText(changed, RESULT_SCHEMA_VERSION),
    );
    expect(check.ok).toBe(false);
    expect(check.problems).toContain(BUMP_MESSAGE);
  });

  it("after bumping to the next version and adding its file plus its hash, the guard passes and the current file is untouched", () => {
    const NEXT = RESULT_SCHEMA_VERSION + 1;
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-schema-"));
    temps.push(dir);
    copyFileSync(
      join(schemaDir, `result.v${RESULT_SCHEMA_VERSION}.json`),
      join(dir, `result.v${RESULT_SCHEMA_VERSION}.json`),
    );
    const v2Schema = resultSchema.extend({ schema: z.literal(NEXT), note: z.string().optional() });
    const v2 = buildSchemaText(v2Schema, NEXT);
    const versions = JSON.parse(readFileSync(join(schemaDir, "versions.json"), "utf8")) as Record<
      string,
      string
    >;
    writeFileSync(join(dir, `result.v${NEXT}.json`), v2);
    writeFileSync(
      join(dir, "versions.json"),
      JSON.stringify({ ...versions, [String(NEXT)]: sha256(v2) }),
    );
    expect(checkSchemaDir(dir, NEXT, v2)).toEqual({ ok: true, problems: [] });
    expect(checkSchemaDir(dir, RESULT_SCHEMA_VERSION, committed)).toEqual({
      ok: true,
      problems: [],
    });
    expect(readFileSync(join(dir, `result.v${RESULT_SCHEMA_VERSION}.json`), "utf8")).toBe(
      committed,
    );
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
    size: "S",
    done: "Done.",
    estimateChanges: "Nothing.",
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
    expect(
      checkSchemaDir(schemaDir, RESULT_SCHEMA_VERSION, committed.replace(/\n/g, "\r\n")).ok,
    ).toBe(true);
  });

  it("the Finding has no evidence union yet: evidence is a plain string in the published schema", () => {
    // G02 defines evidence as a string; if a union is introduced, each variant must appear under oneOf.
    const parsed = JSON.parse(committed) as {
      properties: { findings: { items: { properties: { evidence: unknown } } } };
    };
    expect(parsed.properties.findings.items.properties.evidence).toEqual({ type: "string" });
    expect(findingSchema.shape.evidence).toBeDefined();
    expect(RESULT_SCHEMA_VERSION).toBe(2);
  });
});
