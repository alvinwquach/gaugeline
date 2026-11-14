import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import * as z from "zod";
import { describe, expect, it } from "vitest";
import {
  BRIEF_BUMP_MESSAGE,
  buildSchemaText,
  checkSchemaDir,
} from "../../../../../scripts/lib/schema.js";
import { CheckRegistry, defineCheck, type Finding } from "../../model.js";
import { RESULT_SCHEMA_VERSION, buildResult } from "../../result.js";
import { BRIEF_SCHEMA_VERSION, briefSchema, parseBrief } from "../brief-schema.js";
import { buildBrief } from "../brief.js";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const schemaDir = join(repoRoot, "packages/core/schema");
const schemaText = readFileSync(join(schemaDir, `brief.v${BRIEF_SCHEMA_VERSION}.json`), "utf8");

function ajvValidate(value: unknown): { ok: boolean; errors: string } {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(schemaText) as object);
  const ok = validate(value);
  return { ok, errors: ajv.errorsText(validate.errors) };
}

/** A coach's booking page: invented, with the checks a work order for a coach would list. */
const registry = new CheckRegistry();
for (const [id, size] of [
  ["viewport", "S"],
  ["page-lost-content", "M"],
] as const)
  registry.register(
    defineCheck<unknown>({
      id,
      area: "Visitors",
      severity: "medium",
      title: `Title of ${id}`,
      what: `What is wrong with ${id}.`,
      why: `Why ${id} matters.`,
      fix: `Fix ${id}.`,
      tech: `Tech ${id}`,
      size,
      done: `${id} is gone.`,
      estimateChanges: `Places ${id} is hardcoded.`,
      run: () => [],
    }),
  );
const finding = (checkId: string, evidence: string, url: string): Finding => ({
  checkId,
  severity: "medium",
  title: `Title of ${checkId}`,
  evidence,
  url,
});
const result = buildResult({
  url: "https://ridgeline-coaching.example/book",
  startedAt: new Date("2026-11-10T09:00:00.000Z"),
  findings: [
    finding("viewport", "no viewport meta tag", "https://ridgeline-coaching.example/book"),
    finding("page-lost-content", "the price list is gone", "https://ridgeline-coaching.example/"),
    finding("gone-check", "a removed check", "https://ridgeline-coaching.example/"),
  ],
  passed: [],
  failed: [],
});

describe("brief schema: its own versioned document", () => {
  it("is version 1, and is not the result's number", () => {
    expect(BRIEF_SCHEMA_VERSION).toBe(1);
    expect(RESULT_SCHEMA_VERSION).toBe(2);
  });

  it("a built work order, with and without hours and money, validates against the published file", () => {
    for (const opts of [{}, { hoursPerPoint: 1.5 }, { hoursPerPoint: 1.5, rateMinor: 9500 }]) {
      const brief = JSON.parse(JSON.stringify(buildBrief(result, registry, opts))) as unknown;
      const verdict = ajvValidate(brief);
      expect(verdict.ok, verdict.errors).toBe(true);
    }
  });

  it("an empty work order validates too", () => {
    const empty = buildResult({
      url: "https://ridgeline-coaching.example/",
      startedAt: new Date("2026-11-10T09:00:00.000Z"),
      findings: [],
      passed: [],
      failed: [],
    });
    expect(ajvValidate(buildBrief(empty, registry)).ok).toBe(true);
  });

  it("the file refuses an unknown field, a wrong version and a size that is not S, M or L", () => {
    const brief = JSON.parse(JSON.stringify(buildBrief(result, registry))) as {
      items: { size: string }[];
    };
    expect(ajvValidate({ ...brief, extra: 1 }).ok).toBe(false);
    expect(ajvValidate({ ...brief, schemaVersion: 2 }).ok).toBe(false);
    const bad = { ...brief, items: [{ ...brief.items[0], size: "XL" }] };
    expect(ajvValidate(bad).ok).toBe(false);
    expect(() => parseBrief({ ...brief, schemaVersion: 2 })).toThrow();
  });

  it("holds no field for a key, a header or a body: only names, kinds, counts and evidence lines", () => {
    const keys = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node !== null && typeof node === "object")
        for (const [k, v] of Object.entries(node)) {
          keys.add(k);
          walk(v);
        }
    };
    walk(JSON.parse(schemaText));
    for (const banned of [
      "headers",
      "body",
      "cookie",
      "token",
      "secret",
      "apiKey",
      "authorization",
    ])
      expect(keys.has(banned), banned).toBe(false);
  });

  it("schema:check passes on the committed tree and covers the work order file", () => {
    const tsx = join(repoRoot, "node_modules/tsx/dist/cli.mjs");
    const r = spawnSync(process.execPath, [tsx, "scripts/build-schema.ts", "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`brief.v${BRIEF_SCHEMA_VERSION}.json is up to date.`);
  }, 60_000);

  it("the published file is the zod definition, with its own id and title", () => {
    const text = buildSchemaText(briefSchema, BRIEF_SCHEMA_VERSION, "brief");
    expect(text).toBe(schemaText);
    const parsed = JSON.parse(schemaText) as { $id: string; title: string };
    expect(parsed.$id).toBe("https://gaugeline.dev/schema/brief.v1.json");
    expect(parsed.title).toBe("Gaugeline work order v1");
  });

  it("changing the shape without a new version fails with the work order's bump message", () => {
    const changed = briefSchema.extend({ extra: z.string().optional() });
    const check = checkSchemaDir(
      schemaDir,
      BRIEF_SCHEMA_VERSION,
      buildSchemaText(changed, BRIEF_SCHEMA_VERSION, "brief"),
      "brief",
    );
    expect(check.ok).toBe(false);
    expect(check.problems).toContain(BRIEF_BUMP_MESSAGE);
  });

  it("the result's hash map keeps 1 and 2 and adds 3, and the requests file's keeps its published version 1 hash", () => {
    const read = (name: string): string[] =>
      Object.keys(JSON.parse(readFileSync(join(schemaDir, name), "utf8")) as object);
    expect(read("versions.json")).toEqual(["1", "2", "3"]);
    // Version 2 of the requests file (ADR-0006) was added; version 1 is published and never changes.
    expect(read("requests-versions.json")).toEqual(["1", "2"]);
    const requests = JSON.parse(
      readFileSync(join(schemaDir, "requests-versions.json"), "utf8"),
    ) as Record<string, string>;
    expect(requests["1"]).toBe("52cfefdc625bb91dce8047b7d6bd9f37bff23340516548302f6b4a52385dee91");
    expect(read("brief-versions.json")).toEqual(["1"]);
  });
});
