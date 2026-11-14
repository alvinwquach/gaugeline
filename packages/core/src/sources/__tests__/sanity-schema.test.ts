import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FERNBROOK,
  FERNBROOK_MARKER,
  sanityCountsTransport,
  type SeenSanityRequest,
} from "../../../../testkit/src/index.js";
import { createSanityRead } from "../../connectors/sanity.js";
import { createFetcher } from "../../fetcher.js";
import { ConfigError } from "../../errors.js";
import { parseSchemaExtract } from "../../query/mutations.js";
import { clinicSchema } from "../../content-model/__tests__/helpers.js";
import {
  countType,
  idsNotIn,
  isPlainField,
  modelOf,
  orphanCandidates,
  readModelSchema,
  tallyFields,
} from "../sanity-schema.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function reader(queries: SeenSanityRequest[] = []) {
  const fetcher = createFetcher({ transport: sanityCountsTransport(FERNBROOK, queries) });
  return createSanityRead({ SANITY_PROJECT_ID: "fernbrook1" }, fetcher);
}

describe("reading required fields from an extracted schema", () => {
  it("a field is required unless the extract says optional, per document type", () => {
    const model = modelOf(clinicSchema());
    expect([...model.keys()]).toEqual(["article", "practitioner", "service"]);
    expect(model.get("article")?.required).toEqual(["title", "slug", "author", "summary"]);
    expect(model.get("practitioner")?.required).toEqual(["name", "slug", "role"]);
    expect(model.get("service")?.required).toEqual(["name", "slug"]);
    expect(model.get("article")?.fields.has("archived")).toBe(true);
    // System fields are not in a schema's field list.
    expect(model.get("article")?.fields.has("_id")).toBe(false);
  });

  it("a field required on one type is not required on another that shares its name", () => {
    const model = modelOf(clinicSchema());
    expect(model.get("article")?.required).toContain("summary");
    expect(model.get("practitioner")?.required).not.toContain("summary");
    expect(model.get("service")?.required).not.toContain("summary");
  });

  it("type declarations are not document types", () => {
    const schema = parseSchemaExtract(
      JSON.stringify([
        { type: "type", name: "slug", value: { type: "object", attributes: {} } },
        {
          type: "document",
          name: "post",
          attributes: { title: { type: "objectAttribute", value: { type: "string" } } },
        },
      ]),
    );
    expect([...modelOf(schema).keys()]).toEqual(["post"]);
  });
});

describe("fields looked for because the schema dropped them", () => {
  it("the previous schema's fields that the current one lacks, and the retired ones, sorted", () => {
    const found = orphanCandidates(clinicSchema(), clinicSchema("schema.before.json"), {
      article: ["subtitle", "title"],
    });
    // "title" is still in the schema, so it is never a candidate.
    expect([...found]).toEqual([
      ["article", ["subtitle"]],
      ["practitioner", ["oldSpecialty"]],
      ["service", ["legacyNote"]],
    ]);
  });

  it("is empty when nothing is named", () => {
    expect(orphanCandidates(clinicSchema(), undefined, undefined).size).toBe(0);
  });
});

describe("the schema file", () => {
  function file(text: string): string {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-model-"));
    dirs.push(dir);
    const path = join(dir, "schema.json");
    writeFileSync(path, text);
    return path;
  }

  it("a missing file is a config error that names the setting", async () => {
    await expect(
      readModelSchema(join(tmpdir(), "no-such-gaugeline-schema.json"), "schema"),
    ).rejects.toThrow(
      /gaugeline\.model\.json: schema: the file ".*no-such-gaugeline-schema\.json" could not be read/,
    );
  });

  it("something that is not a schema extract is a config error too", async () => {
    const error = await readModelSchema(file('{"hello":1}'), "previousSchema").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("previousSchema");
    expect((error as Error).message).toContain("is not a schema extract");
  });

  it("reads a file that starts with a byte order mark", async () => {
    const text = JSON.stringify([
      {
        type: "document",
        name: "post",
        attributes: { title: { type: "objectAttribute", value: { type: "string" } } },
      },
    ]);
    const schema = await readModelSchema(file(`\uFEFF${text}`), "schema");
    expect(modelOf(schema).get("post")?.required).toEqual(["title"]);
  });
});

describe("asking the dataset: counts and ids, published documents only", () => {
  it("counts the documents with no value in a field and names the first three by id", async () => {
    const queries: SeenSanityRequest[] = [];
    const got = await tallyFields(reader(queries), "article", ["summary", "title"], "missing");
    expect(got.total).toBe(48);
    expect(got.byField.get("summary")).toEqual({
      count: 17,
      ids: ["article-32", "article-33", "article-34"],
    });
    expect(got.byField.get("title")).toEqual({ count: 0, ids: [] });
    // One request, and the two drafts were not counted.
    expect(queries).toHaveLength(1);
    expect(queries[0]?.url).toContain("perspective=published");
  });

  it("counts the documents that have a value, for a field the schema dropped", async () => {
    const got = await tallyFields(reader(), "practitioner", ["oldSpecialty", "nope"], "populated");
    expect(got.byField.get("oldSpecialty")).toEqual({
      count: 2,
      ids: ["practitioner-ben", "practitioner-dee"],
    });
    expect(got.byField.get("nope")?.count).toBe(0);
  });

  it("asks only for counts and ids: no value of any document is in a request or an answer", async () => {
    const queries: SeenSanityRequest[] = [];
    const got = await tallyFields(reader(queries), "article", ["summary"], "missing");
    expect(JSON.stringify(got)).not.toContain(FERNBROOK_MARKER);
    for (const q of queries) expect(q.query).not.toMatch(/\{\s*\w+\s*[,}]/);
  });

  it("leaves out a field whose name cannot be written into a query, and says which", async () => {
    const got = await tallyFields(reader(), "article", ["summary", "two words", "true"], "missing");
    expect(got.skipped).toEqual(["two words", "true"]);
    expect([...got.byField.keys()]).toEqual(["summary"]);
    expect(isPlainField("summary")).toBe(true);
    expect(isPlainField("null")).toBe(false);
  });

  it("a type with no field to ask about is only counted", async () => {
    expect(await tallyFields(reader(), "article", [], "missing")).toEqual({
      total: 48,
      byField: new Map(),
      skipped: [],
    });
  });

  it("splits a request whose address would be too long, and still answers every field", async () => {
    const fields = Array.from({ length: 8 }, (_, i) => `field${"x".repeat(500)}${i}`);
    const queries: SeenSanityRequest[] = [];
    const got = await tallyFields(reader(queries), "article", fields, "populated");
    expect([...got.byField.keys()]).toEqual(fields);
    expect(queries.length).toBeGreaterThan(1);
  });

  it("counts a type, narrowed by a filter", async () => {
    expect(await countType(reader(), "article")).toBe(48);
    expect(await countType(reader(), "article", "defined(summary)")).toBe(31);
    expect(await countType(reader(), "article", "!defined(summary)")).toBe(17);
    expect(await countType(reader(), "nothing")).toBe(0);
  });

  it("names the ids whose slug is not on the page, in id order and up to a limit", async () => {
    const shown = Array.from({ length: 31 }, (_, i) => `tip-${String(i + 1).padStart(2, "0")}`);
    expect(await idsNotIn(reader(), "article", undefined, "slug.current", shown, 3)).toEqual({
      ok: true,
      ids: ["article-32", "article-33", "article-34"],
    });
    expect(
      await idsNotIn(reader(), "article", undefined, "slug.current", shown, 100),
    ).toMatchObject({
      ok: true,
      ids: expect.arrayContaining(["article-48"]) as string[],
    });
  });

  it("does not name ids when a slug is not plain, rather than putting it in a query", async () => {
    const got = await idsNotIn(reader(), "article", undefined, "slug.current", ['a"] || true'], 10);
    expect(got.ok).toBe(false);
  });
});
