import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import * as z from "zod";
import { describe, expect, it } from "vitest";
import {
  REQUESTS_BUMP_MESSAGE,
  buildSchemaText,
  checkSchemaDir,
} from "../../../../scripts/lib/schema.js";
import { RESULT_SCHEMA_VERSION } from "../result.js";
import {
  MAX_SAVED_PAGE_BYTES,
  MAX_SAVED_REQUESTS,
  REQUESTS_FILE_SCHEMA_VERSION,
  buildRequestsFile,
  parseRequestsFile,
  requestsFileSchema,
  requestsFileSchemaV1,
} from "../requests-file.js";
import type { PageData } from "../run-view.js";
import type { RequestRow } from "../request-log.js";

// Put together at run time, so no key-shaped string is in the repository.
const STRIPE = ["sk", "live", "RequestsFileNotARealKey00"].join("_");
const GITHUB = ["ghp", "RequestsFileNotARealToken0000000000"].join("_");
const QUERY = "hunter2queryvalue";

const schemaText = readFileSync(
  fileURLToPath(
    new URL(`../../schema/requests.v${REQUESTS_FILE_SCHEMA_VERSION}.json`, import.meta.url),
  ),
  "utf8",
);
function ajvValidate(value: unknown): { ok: boolean; errors: string } {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(schemaText) as object);
  const ok = validate(value);
  return { ok, errors: ajv.errorsText(validate.errors) };
}

const row = (over: Partial<RequestRow> = {}): RequestRow => ({
  url: "https://shop.example/about",
  kind: "link",
  method: "HEAD",
  status: 200,
  ms: 12,
  ...over,
});
const page = (over: Partial<PageData> = {}): PageData => ({
  url: "https://shop.example/",
  title: "Larkspur Pottery",
  canonical: "https://shop.example/",
  words: 4,
  firstWords: "Hand thrown mugs daily",
  blocks: [],
  ...over,
});
const build = (
  over: { requests?: RequestRow[]; page?: PageData } = {},
  caps?: Parameters<typeof buildRequestsFile>[1],
) =>
  buildRequestsFile(
    {
      url: "https://shop.example/",
      startedAt: new Date("2026-11-09T20:00:00Z"),
      version: "0.1.0",
      requests: over.requests ?? [row()],
      page: over.page ?? page(),
    },
    caps,
  );

describe("requests file: unit", () => {
  it("names its schema version, says what is in it, and validates against the zod schema and the published JSON Schema", () => {
    const file = build();
    expect(file.schemaVersion).toBe(REQUESTS_FILE_SCHEMA_VERSION);
    expect(file.schemaVersion).toBe(2);
    expect(file.generatedBy).toBe("Gaugeline 0.1.0");
    expect(file.startedAt).toBe("2026-11-09T20:00:00.000Z");
    expect(file.notice).toMatch(/page content/);
    expect(file.notice).toMatch(/do not commit/i);
    expect(requestsFileSchema.safeParse(file).success).toBe(true);
    expect(ajvValidate(file)).toEqual({ ok: true, errors: "No errors" });
  });

  it("an unknown key or a wrong schema number is refused by both validators", () => {
    const file = build();
    expect(requestsFileSchema.safeParse({ ...file, extra: 1 }).success).toBe(false);
    expect(requestsFileSchema.safeParse({ ...file, schemaVersion: 3 }).success).toBe(false);
    expect(ajvValidate({ ...file, extra: 1 }).ok).toBe(false);
    expect(ajvValidate({ ...file, schemaVersion: 3 }).ok).toBe(false);
  });

  it("the caps are named constants: 256 KB of page text and a request count", () => {
    expect(MAX_SAVED_PAGE_BYTES).toBe(256 * 1024);
    expect(MAX_SAVED_REQUESTS).toBe(1000);
    const file = build();
    expect(file.truncation).toMatchObject({
      truncated: false,
      maxPageBytes: MAX_SAVED_PAGE_BYTES,
      maxRequests: MAX_SAVED_REQUESTS,
      requestsTotal: 1,
      requestsSaved: 1,
      notes: [],
    });
    expect(file.page.truncated).toEqual([]);
  });

  it("the same input gives byte-identical output", () => {
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it("optional fields stay absent: no title, no canonical, no location, no error", () => {
    const file = build({
      page: { url: "https://shop.example/", words: 0, firstWords: "", blocks: [] },
      requests: [row({ status: null, error: "timeout" })],
    });
    expect("title" in file.page).toBe(false);
    expect("canonical" in file.page).toBe(false);
    expect(file.requests[0]).toMatchObject({ status: null, error: "timeout" });
    expect("location" in (file.requests[0] ?? {})).toBe(false);
    expect(ajvValidate(file).ok).toBe(true);
  });
});

describe("requests file: redaction (the same redact() findings and reports use)", () => {
  it("removes key-shaped text and secret query parameters from every string, wherever it sits", () => {
    const file = build({
      requests: [
        row({ url: `https://shop.example/next?token=${QUERY}&page=2` }),
        row({
          url: "https://shop.example/moved",
          status: 301,
          location: `https://shop.example/landing?api_key=${QUERY}`,
        }),
        row({ url: `https://shop.example/${STRIPE}` }),
      ],
      page: page({
        url: `https://shop.example/?sig=${QUERY}`,
        title: `Order ${STRIPE}`,
        canonical: `https://shop.example/?secret=${QUERY}`,
        firstWords: `Call us. Bearer abcdefghijklmnop and ${GITHUB} are here`,
        blocks: [
          { ok: true, value: { "@type": "Thing", note: STRIPE, nested: [{ k: GITHUB }] } },
          { ok: false, raw: `{"a": "${STRIPE}"`, error: `Unexpected token near ${GITHUB}` },
        ],
      }),
    });
    const text = JSON.stringify(file);
    for (const secret of [STRIPE, GITHUB, QUERY, "abcdefghijklmnop"])
      expect(text, secret).not.toContain(secret);
    expect(text).toContain("token=[redacted]");
    expect(text).toContain("page=2");
    // The shape survives: still valid, same number of blocks.
    expect(requestsFileSchema.safeParse(file).success).toBe(true);
    expect(file.page.blocks).toHaveLength(2);
  });

  it("a redaction that meets a quote or a backslash does not break the file", () => {
    const file = build({
      page: page({
        blocks: [{ ok: true, value: { a: `see ?token=${QUERY}" and more \\ text`, b: [1, null] } }],
      }),
    });
    const round = JSON.parse(JSON.stringify(file)) as unknown;
    expect(requestsFileSchema.safeParse(round).success).toBe(true);
    expect(JSON.stringify(file)).not.toContain(QUERY);
  });

  it("redacts the address the run was started with, and the tool version line is never a key", () => {
    const file = buildRequestsFile({
      url: `https://shop.example/?key=${QUERY}`,
      startedAt: new Date("2026-11-09T20:00:00Z"),
      version: "0.1.0",
      requests: [],
      page: page(),
    });
    expect(file.url).toBe("https://shop.example/?key=[redacted]");
  });
});

describe("requests file: size caps", () => {
  it("cuts the requests at the cap, keeps the first ones, and says so in the file", () => {
    const requests = Array.from({ length: 7 }, (_, i) =>
      row({ url: `https://shop.example/p${i}` }),
    );
    const file = build({ requests }, { maxRequests: 5 });
    expect(file.requests.map((r) => r.url)).toEqual(
      [0, 1, 2, 3, 4].map((i) => `https://shop.example/p${i}`),
    );
    expect(file.truncation).toMatchObject({
      truncated: true,
      maxRequests: 5,
      requestsTotal: 7,
      requestsSaved: 5,
    });
    expect(file.truncation.notes.join(" ")).toMatch(/7 requests.*first 5/);
    expect(requestsFileSchema.safeParse(file).success).toBe(true);
  });

  it("exactly at the cap is not truncated", () => {
    const requests = Array.from({ length: 5 }, (_, i) =>
      row({ url: `https://shop.example/p${i}` }),
    );
    expect(build({ requests }, { maxRequests: 5 }).truncation.truncated).toBe(false);
  });

  it("cuts text that is over the page cap, marks the field, and notes it at the top", () => {
    const file = build(
      { page: page({ firstWords: "word ".repeat(400).trim() }) },
      { maxPageBytes: 300 },
    );
    expect(file.page.truncated).toEqual(["firstWords"]);
    expect(Buffer.byteLength(file.page.firstWords)).toBeLessThanOrEqual(300);
    expect(file.truncation.truncated).toBe(true);
    expect(file.truncation.notes.join(" ")).toContain("page.firstWords");
    expect(file.truncation.notes.join(" ")).toContain("300");
    expect(ajvValidate(file).ok).toBe(true);
  });

  it("the page cap counts the whole page: the title, the preview and every block share it", () => {
    const big = { ok: true as const, value: { text: "x".repeat(700) } };
    const file = build({ page: page({ blocks: [big, big, big, big] }) }, { maxPageBytes: 2000 });
    const kept = file.page.blocks;
    expect(kept.length + file.page.blocksOmitted).toBe(4);
    expect(file.page.blocksOmitted).toBeGreaterThan(0);
    expect(file.page.truncated).toContain("blocks");
    const bytes =
      Buffer.byteLength(file.page.title ?? "") +
      Buffer.byteLength(file.page.canonical ?? "") +
      Buffer.byteLength(file.page.firstWords) +
      kept.reduce(
        (n, b) => n + Buffer.byteLength(b.ok ? JSON.stringify(b.value) : `${b.raw}${b.error}`),
        0,
      );
    expect(bytes).toBeLessThanOrEqual(2000);
  });

  it("a block that does not fit whole is kept as cut raw text and marked truncated: true", () => {
    const file = build(
      { page: page({ blocks: [{ ok: true, value: { text: "y".repeat(5000) } }] }) },
      { maxPageBytes: 1000 },
    );
    const block = file.page.blocks[0];
    expect(block).toMatchObject({ ok: false, truncated: true });
    expect(block && !block.ok && block.raw.startsWith('{"text":"yyy')).toBe(true);
    expect(file.page.truncated).toContain("blocks");
    expect(ajvValidate(file).ok).toBe(true);
  });

  it("a cut never leaves half a character", () => {
    const file = build(
      { page: page({ title: "", canonical: "", firstWords: "\u00E9\u4E2D\u{1f600}".repeat(200) }) },
      { maxPageBytes: 101 },
    );
    expect(file.page.firstWords).not.toContain("\uFFFD");
    expect(Buffer.byteLength(file.page.firstWords)).toBeLessThanOrEqual(101);
  });

  it("a cut that would leave the front of a key is made after redaction, so no key prefix survives", () => {
    const text = `${"a ".repeat(20)}${STRIPE} tail`;
    const file = build({ page: page({ firstWords: text }) }, { maxPageBytes: 60 });
    expect(JSON.stringify(file)).not.toContain(STRIPE);
    expect(JSON.stringify(file)).not.toContain("sk_live_Requests");
  });

  it("the default caps leave a normal page whole", () => {
    const file = build({
      page: page({
        firstWords: "word ".repeat(200).trim(),
        blocks: [{ ok: true, value: { a: 1 } }],
      }),
    });
    expect(file.truncation.truncated).toBe(false);
    expect(file.page.blocks).toHaveLength(1);
  });
});

describe("requests file: its schema is versioned apart from the result's", () => {
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const schemaDir = join(repoRoot, "packages/core/schema");

  it("schema:check passes on the committed tree and covers both files", () => {
    const tsx = join(repoRoot, "node_modules/tsx/dist/cli.mjs");
    const r = spawnSync(process.execPath, [tsx, "scripts/build-schema.ts", "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("requests.v2.json is up to date.");
    expect(r.stdout).toContain(`result.v${RESULT_SCHEMA_VERSION}.json is up to date.`);
  });

  it("the published file is the zod definition, with its own id and title", () => {
    const text = buildSchemaText(requestsFileSchema, REQUESTS_FILE_SCHEMA_VERSION, "requests");
    expect(text).toBe(schemaText);
    const parsed = JSON.parse(schemaText) as { $id: string; title: string };
    expect(parsed.$id).toBe("https://gaugeline.dev/schema/requests.v2.json");
    expect(parsed.title).toBe("Gaugeline saved requests file v2");
  });

  it("changing the shape without a new version fails with the requests bump message, not the result's", () => {
    const changed = requestsFileSchema.extend({ extra: z.string().optional() });
    const check = checkSchemaDir(
      schemaDir,
      REQUESTS_FILE_SCHEMA_VERSION,
      buildSchemaText(changed, REQUESTS_FILE_SCHEMA_VERSION, "requests"),
      "requests",
    );
    expect(check.ok).toBe(false);
    expect(check.problems).toContain(REQUESTS_BUMP_MESSAGE);
  });

  it("the result's hash map keeps versions 1 and 2 and adds 3 (the opt-in schema with the suppressed fields)", () => {
    const versions = JSON.parse(readFileSync(join(schemaDir, "versions.json"), "utf8")) as object;
    expect(Object.keys(versions)).toEqual(["1", "2", "3"]);
  });
});

describe("requests file: queries (ADR-0006) and version 1", () => {
  const query = row({
    url: "https://api.vendor.example/v2/items/query",
    kind: "query",
    method: "POST",
    allow: "wix-data-query",
  });

  it("a query is saved with its allowlist id, and validates against both validators", () => {
    const file = build({ requests: [row(), query] });
    expect(file.requests[1]).toEqual({
      url: "https://api.vendor.example/v2/items/query",
      kind: "query",
      method: "POST",
      allow: "wix-data-query",
      status: 200,
      ms: 12,
    });
    expect(requestsFileSchema.safeParse(file).success).toBe(true);
    expect(ajvValidate(file)).toEqual({ ok: true, errors: "No errors" });
    expect(JSON.stringify(file)).not.toMatch(/body|authorization/i);
  });

  it("a file of version 1 is still read, and is not given a query", () => {
    const v1 = { ...build({ requests: [row()] }), schemaVersion: 1 };
    const parsed = parseRequestsFile(v1);
    expect(parsed.schemaVersion).toBe(1);
    expect(requestsFileSchemaV1.safeParse(v1).success).toBe(true);
    const withQuery = { ...build({ requests: [query] }), schemaVersion: 1 };
    expect(() => parseRequestsFile(withQuery)).toThrow();
    expect(requestsFileSchema.safeParse(v1).success).toBe(false);
  });

  it("the published version 1 schema file is untouched", () => {
    const schemaDir = join(
      fileURLToPath(new URL("../../../../", import.meta.url)),
      "packages/core/schema",
    );
    const v1 = readFileSync(join(schemaDir, "requests.v1.json"), "utf8");
    expect(JSON.parse(v1).properties.requests.items.properties.method.enum).toEqual([
      "GET",
      "HEAD",
    ]);
    const versions = JSON.parse(
      readFileSync(join(schemaDir, "requests-versions.json"), "utf8"),
    ) as object;
    expect(Object.keys(versions)).toEqual(["1", "2"]);
  });
});
