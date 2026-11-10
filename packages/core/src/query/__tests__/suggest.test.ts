import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parse } from "groq-js";
import { describe, expect, it } from "vitest";
import {
  CONTENT_MARKER,
  NORTHFIELD_CONTENT,
  sanityCountsTransport,
  type FakeSanity,
  type SeenSanityRequest,
} from "../../../../testkit/src/index.js";
import { createSanityRead } from "../../connectors/sanity.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { readContentShape, type ContentShape, type FieldShape } from "../content-shape.js";
import { parseSchemaExtract, readSchemaFileFull, type SchemaFile } from "../mutations.js";
import { projection, suggestQuery } from "../suggest.js";

const f = (
  name: string,
  kind: FieldShape["kind"],
  present: number,
  more: Partial<FieldShape> = {},
): FieldShape => ({ name, kind, present, ...more });

/** The 12-document resource shape from docs/query-check.md. */
const RESOURCE: ContentShape = {
  type: "resource",
  sampled: 12,
  fields: [
    f("title", "string", 12),
    f("slug", "slug", 12),
    f("summary", "string", 12),
    f("topic", "reference", 12),
    f("body", "portable-text", 12),
    f("heroImage", "image", 12, { instances: 12, of: [f("alt", "string", 6)] }),
    f("tags", "array", 12, { item: "string" }),
    f("publishedAt", "string", 6),
    f("gatedFile", "file", 4),
  ],
};

const DOCS_EXAMPLE = [
  "// resource, written from 12 published documents",
  "// publishedAt is present on 50% of the sample",
  "// gatedFile is present on 33% of the sample",
  '*[_type == "resource" && !(_id in path("drafts.**"))] | order(_updatedAt desc) {',
  "  _id,",
  "  title,",
  '  "slug": slug.current,',
  "  summary,",
  '  topic->{ _id, title, "slug": slug.current },',
  "  body,",
  '  heroImage{ "url": asset->url, "alt": coalesce(alt, "") },',
  "  tags[],",
  '  "publishedAt": coalesce(publishedAt, ""),',
  '  gatedFile{ "url": asset->url, "name": asset->originalFilename, "size": asset->size }',
  "}",
].join("\n");

const shaped = (fields: FieldShape[], sampled = 12): ContentShape => ({
  type: "resource",
  sampled,
  fields,
});

describe("projection: the entries the route scaffold shares with suggestQuery", () => {
  it("gives the entries by field name, and the same text suggestQuery prints", () => {
    const { entries, comments } = projection(RESOURCE);
    expect(entries.map((e) => e.name)).toEqual(RESOURCE.fields.map((x) => x.name));
    expect(comments).toEqual([
      "// publishedAt is present on 50% of the sample",
      "// gatedFile is present on 33% of the sample",
    ]);
    expect(entries.map((e) => `  ${e.text}`).join(",\n")).toContain('  "slug": slug.current,');
  });

  it("imageSize adds the asset's width and height to an image, and keeps a field of that name out of the way", () => {
    const sized = projection(
      shaped([
        f("photo", "image", 12, { instances: 12, of: [f("width", "number", 12)] }),
        f("gallery", "array", 12, { item: "image", instances: 5 }),
      ]),
      { imageSize: true },
    ).entries.map((e) => e.text);
    expect(sized[0]).toBe(
      'photo{ "url": asset->url, "alt": coalesce(alt, ""), "width": asset->metadata.dimensions.width, "height": asset->metadata.dimensions.height }',
    );
    expect(sized[1]).toContain('gallery[]{ "url": asset->url');
    expect(sized[1]).toContain('"height": asset->metadata.dimensions.height');
    // Without it nothing changes, and a field called width is an ordinary field.
    const plain = projection(
      shaped([f("photo", "image", 12, { instances: 12, of: [f("width", "number", 12)] })]),
    ).entries[0]?.text;
    expect(plain).toBe('photo{ "url": asset->url, "alt": coalesce(alt, ""), width }');
  });
});

describe("suggestQuery: unit", () => {
  it("the 12-document resource shape prints the docs example, line for line", () => {
    expect(suggestQuery(RESOURCE)).toBe(DOCS_EXAMPLE);
  });

  it("the same shape gives the same text every time", () => {
    expect(suggestQuery(RESOURCE)).toBe(suggestQuery(structuredClone(RESOURCE)));
  });

  it("6 of 12 prints 50%, 4 of 12 prints 33%, and a field on all 12 has no comment and no coalesce", () => {
    const q = suggestQuery(
      shaped([f("a", "string", 12), f("b", "string", 6), f("c", "number", 4)]),
    );
    expect(q).toContain("// b is present on 50% of the sample");
    expect(q).toContain("// c is present on 33% of the sample");
    expect(q).not.toContain("// a ");
    expect(q).toContain("\n  a,\n");
    expect(q).toContain('"b": coalesce(b, ""),');
    expect(q).toContain('"c": coalesce(c, 0)');
  });

  it("never prints 0% or 100% for a field that is on some but not all documents", () => {
    const q = suggestQuery(shaped([f("rare", "string", 1, {}), f("nearly", "string", 399)], 400));
    expect(q).toContain("// rare is present on 1% of the sample");
    expect(q).toContain("// nearly is present on 99% of the sample");
  });

  it("says the real number of documents, and the singular for one", () => {
    expect(suggestQuery(shaped([f("title", "string", 5)], 5)).split("\n")[0]).toBe(
      "// resource, written from 5 published documents",
    );
    expect(suggestQuery(shaped([f("title", "string", 1)], 1)).split("\n")[0]).toBe(
      "// resource, written from 1 published document",
    );
  });

  it("an optional boolean, slug, array and Portable Text are coalesced; objects, images, files and references are not", () => {
    const q = suggestQuery(
      shaped([
        f("featured", "boolean", 3),
        f("slug", "slug", 3),
        f("tags", "array", 3, { item: "string" }),
        f("body", "portable-text", 3),
        f("venue", "reference", 3),
        f("photo", "image", 3, { instances: 3 }),
        f("file", "file", 3),
        f("seo", "object", 3, { instances: 3, of: [f("title", "string", 3)] }),
      ]),
    );
    expect(q).toContain('"featured": coalesce(featured, false),');
    expect(q).toContain('"slug": coalesce(slug.current, ""),');
    expect(q).toContain('"tags": coalesce(tags[], []),');
    expect(q).toContain('"body": coalesce(body, []),');
    expect(q).toContain('  venue->{ _id, title, "slug": slug.current },');
    expect(q).toContain('  photo{ "url": asset->url, "alt": coalesce(alt, "") },');
    expect(q).toContain("  seo{ title }");
    expect(q).not.toMatch(/coalesce\((venue|photo|file|seo)/);
  });

  it("a reference inside an array of objects is dereferenced at the right depth", () => {
    const q = suggestQuery(
      shaped([
        f("sections", "array", 12, {
          item: "object",
          instances: 30,
          of: [
            f("heading", "string", 30),
            f("author", "reference", 30),
            f("related", "array", 30, { item: "reference" }),
            f("note", "string", 15),
          ],
        }),
      ]),
    );
    expect(q).toContain(
      [
        "  sections[]{",
        "    heading,",
        '    author->{ _id, title, "slug": slug.current },',
        '    related[]->{ _id, title, "slug": slug.current },',
        '    "note": coalesce(note, "")',
        "  }",
      ].join("\n"),
    );
    expect(() => parse(q)).not.toThrow();
    expect(q).toContain("// sections.note is present on 50% of the sections items");
  });

  it("an array of images is resolved to addresses, and an array of files gets a name and size", () => {
    const q = suggestQuery(
      shaped([
        f("gallery", "array", 12, { item: "image", instances: 0 }),
        f("downloads", "array", 12, { item: "file", instances: 0 }),
      ]),
    );
    expect(q).toContain('  gallery[]{ "url": asset->url, "alt": coalesce(alt, "") },');
    expect(q).toContain(
      '  downloads[]{ "url": asset->url, "name": asset->originalFilename, "size": asset->size }',
    );
  });

  it("an optional nested field in an object is compared with the documents that have the object", () => {
    const q = suggestQuery(
      shaped([
        f("seo", "object", 8, {
          instances: 8,
          of: [f("title", "string", 8), f("description", "string", 4)],
        }),
      ]),
    );
    expect(q).toContain("// seo is present on 67% of the sample");
    expect(q).toContain("// seo.description is present on 50% of the documents that have seo");
    expect(q).toContain('  seo{ title, "description": coalesce(description, "") }');
  });

  it("a long object is written over several lines, indented", () => {
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
    const q = suggestQuery(
      shaped([
        f("details", "object", 12, {
          instances: 12,
          of: names.map((n) => f(`${n}Field`, "string", 12)),
        }),
      ]),
    );
    expect(q).toContain(
      "  details{\n    alphaField,\n    bravoField,\n    charlieField,\n    deltaField,\n    echoField,\n    foxtrotField,\n    golfField,\n    hotelField\n  }",
    );
    expect(() => parse(q)).not.toThrow();
  });

  it("a field the schema lets be a string or an object is written plainly, with a comment naming both kinds", () => {
    const q = suggestQuery(
      shaped([f("notes", "string", 12, { mixed: ["string", "object"] }), f("title", "string", 12)]),
    );
    expect(q).toContain("// notes can be a string or an object (the schema allows both)");
    expect(q).toContain("\n  notes,\n");
    expect(q).not.toContain("coalesce(notes");
  });

  it("three kinds are all named", () => {
    const q = suggestQuery(
      shaped([f("value", "string", 12, { mixed: ["string", "number", "object"] })]),
    );
    expect(q).toContain("// value can be a string, a number or an object (the schema allows each)");
  });

  it("an array whose items can be of more than one kind is written as name[], with a comment", () => {
    const q = suggestQuery(
      shaped([f("blocks", "array", 12, { itemsMixed: ["reference", "object"] })]),
    );
    expect(q).toContain(
      "// blocks has items that can be a reference or an object, so it is written as blocks[]",
    );
    expect(q).toContain("\n  blocks[]\n}");
  });

  it("a field on none of the documents is left out, with a comment, and so is a nested one", () => {
    const q = suggestQuery(
      shaped([
        f("title", "string", 12),
        f("summary", "string", 0),
        f("seo", "object", 5, {
          instances: 5,
          of: [f("title", "string", 5), f("note", "string", 0)],
        }),
      ]),
    );
    expect(q).toContain("// summary is in the schema and on none of the sample, so it is left out");
    expect(q).toContain(
      "// seo.note is in the schema and on none of the documents that have seo, so it is left out",
    );
    expect(q).not.toMatch(/\n {2}summary/);
    expect(q).toContain("  seo{ title }");
    expect(() => parse(q)).not.toThrow();
  });

  it("a name that is not a plain identifier is quoted, and a reserved word too", () => {
    const q = suggestQuery(
      shaped([f("gated-file", "string", 12), f("match", "string", 12), f("in", "slug", 12)]),
    );
    expect(q).toContain('  "gated-file": @["gated-file"],');
    expect(q).toContain('  "match": @["match"],');
    expect(q).toContain('  "in": @["in"].current');
    expect(() => parse(q)).not.toThrow();
  });

  it("says how many fields were left out because their names cannot be written", () => {
    const q = suggestQuery({ ...shaped([f("title", "string", 12)]), skipped: 2 });
    expect(q).toContain("// 2 fields with names that cannot be written plainly were left out");
  });

  it("refuses a shape of no documents and a type name that is not one", () => {
    expect(() => suggestQuery({ type: "topic", sampled: 0, fields: [] })).toThrow(
      /Nothing of type topic exists/,
    );
    expect(() => suggestQuery({ ...RESOURCE, type: 'x"] || true //' })).toThrow(
      /not a Sanity document type name/,
    );
  });

  it("every query it prints parses as GROQ", () => {
    for (const s of [RESOURCE, shaped([f("title", "string", 12)])])
      expect(() => parse(suggestQuery(s))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// readContentShape: the schema gives names and kinds, count queries give how common each is
// ---------------------------------------------------------------------------------------------

const ENV = { SANITY_PROJECT_ID: "northfield", SANITY_DATASET: "production" };
const SCHEMA_FILE = fileURLToPath(
  new URL("../../../../fixtures/repo-gql/schema.json", import.meta.url),
);

/** What the fake answered, as text, for every request: the recorded responses. */
interface Recorded {
  seen: SeenSanityRequest[];
  responses: string[];
}

function recording(spec: FakeSanity): { transport: Transport; recorded: Recorded } {
  const recorded: Recorded = { seen: [], responses: [] };
  const inner = sanityCountsTransport(spec, recorded.seen);
  const transport: Transport = async (url, req) => {
    const res = await inner(url, req);
    const chunks: Buffer[] = [];
    for await (const c of res.body) chunks.push(Buffer.from(c as Uint8Array));
    const text = Buffer.concat(chunks).toString("utf8");
    recorded.responses.push(text);
    return { ...res, body: Readable.from([Buffer.from(text)]) };
  };
  return { transport, recorded };
}

function readerFor(spec: FakeSanity, env: Record<string, string> = ENV) {
  const { transport, recorded } = recording(spec);
  return {
    read: createSanityRead(env, createFetcher({ transport, timeoutMs: 5000 })),
    recorded,
  };
}

// A schema extract in the shape `sanity schema extract` writes, built from small helpers.
const A = (value: unknown, optional = false) => ({ type: "objectAttribute", value, optional });
const STR = { type: "string" };
const ref = (to: string) => ({
  type: "object",
  attributes: { _ref: A(STR), _type: A({ type: "string", value: "reference" }) },
  dereferencesTo: to,
});
const doc = (name: string, attributes: Record<string, unknown>) => ({
  type: "document",
  name,
  attributes: { _id: A(STR), _type: A({ type: "string", value: name }), ...attributes },
});
const schemaOf = (...items: unknown[]): SchemaFile =>
  parseSchemaExtract(JSON.stringify(items), "schema.json");

describe("readContentShape: integration (invented Sanity answers)", () => {
  async function northfield(): Promise<SchemaFile> {
    return readSchemaFileFull(SCHEMA_FILE);
  }

  it("12 documents: the kinds of slug, reference, image, file and Portable Text are right", async () => {
    const { read } = readerFor(NORTHFIELD_CONTENT);
    const shape = await readContentShape("resource", read, await northfield());
    expect(shape.type).toBe("resource");
    expect(shape.sampled).toBe(12);
    expect(shape.fields.map((x) => [x.name, x.kind])).toEqual([
      ["title", "string"],
      ["slug", "slug"],
      ["summary", "string"],
      ["topic", "reference"],
      ["body", "portable-text"],
      ["heroImage", "image"],
      ["tags", "array"],
      ["publishedAt", "string"],
      ["gatedFile", "file"],
    ]);
    expect(Object.fromEntries(shape.fields.map((x) => [x.name, x.present]))).toEqual({
      title: 12,
      slug: 12,
      summary: 12,
      topic: 12,
      body: 12,
      heroImage: 12,
      tags: 12,
      publishedAt: 6,
      gatedFile: 4,
    });
    expect(shape.fields.find((x) => x.name === "tags")?.item).toBe("string");
  });

  it("the recorded responses contain key names and kind names only: integers under p0, p1 and total, no value", async () => {
    const { read, recorded } = readerFor(NORTHFIELD_CONTENT);
    await readContentShape("resource", read, await northfield());
    expect(recorded.responses.length).toBeGreaterThan(0);
    for (const text of recorded.responses) {
      const body = JSON.parse(text) as { result: Record<string, unknown> };
      const keys = Object.keys(body.result);
      expect(keys).toContain("total");
      for (const k of keys) {
        expect(k).toMatch(/^(total|p\d+)$/);
        expect(Number.isSafeInteger(body.result[k])).toBe(true);
      }
      expect(text.toLowerCase()).not.toContain(CONTENT_MARKER.toLowerCase());
    }
  });

  it("the shape fed to suggestQuery gives the docs example", async () => {
    const { read } = readerFor(NORTHFIELD_CONTENT);
    const shape = await readContentShape("resource", read, await northfield());
    expect(suggestQuery(shape)).toBe(DOCS_EXAMPLE);
  });

  it("sends one GET of count queries over the newest 50 published documents, and each query parses", async () => {
    const { read, recorded } = readerFor(NORTHFIELD_CONTENT);
    await readContentShape("resource", read, await northfield());
    expect(recorded.seen).toHaveLength(1);
    const [only] = recorded.seen;
    expect(only?.method).toBe("GET");
    const newest =
      '(*[_type == "resource" && !(_id in path("drafts.**"))] | order(_updatedAt desc)[0...50])';
    expect(only?.query).toContain(`"total":count(${newest})`);
    expect(only?.query).toContain(`"p1":count(${newest}[defined(title)])`);
    expect(only?.query).toContain(`"p9":count(${newest}[defined(gatedFile)])`);
    expect(() => parse(only?.query ?? "")).not.toThrow();
    expect(new URL(only?.url ?? "").searchParams.get("perspective")).toBe("published");
    // Only counts: every attribute of the answer is a count() call.
    const tree = parse(only?.query ?? "") as unknown as {
      attributes: { value: { type: string; name?: string } }[];
    };
    for (const a of tree.attributes)
      expect(a.value).toMatchObject({ type: "FuncCall", name: "count" });
  });

  it("drafts are left out: a document only a draft has is not counted", async () => {
    const { read } = readerFor(NORTHFIELD_CONTENT);
    const shape = await readContentShape("resource", read, await northfield());
    expect(shape.sampled).toBe(12);
  });

  it("a sample of 5 counts the 5 newest documents and says 5", async () => {
    const { read } = readerFor(NORTHFIELD_CONTENT);
    const shape = await readContentShape("resource", read, await northfield(), 5);
    expect(shape.sampled).toBe(5);
    // The newest five are resource-01 .. resource-05: gatedFile is on 4 of them, publishedAt on all 5.
    expect(shape.fields.find((x) => x.name === "gatedFile")?.present).toBe(4);
    expect(shape.fields.find((x) => x.name === "publishedAt")?.present).toBe(5);
  });

  it("a type with fewer documents than the sample says the real number in the header", async () => {
    const { read } = readerFor(NORTHFIELD_CONTENT);
    const shape = await readContentShape("resource", read, await northfield(), 200);
    expect(shape.sampled).toBe(12);
    expect(suggestQuery(shape).split("\n")[0]).toBe(
      "// resource, written from 12 published documents",
    );
  });

  it("a type with no published documents is a shape of none", async () => {
    const { read } = readerFor(NORTHFIELD_CONTENT);
    const shape = await readContentShape("topic", read, await northfield());
    expect(shape).toEqual({ type: "topic", sampled: 0, fields: [] });
  });

  it("a type the schema does not declare is a ConfigError that names what it has, and sends nothing", async () => {
    const { read, recorded } = readerFor(NORTHFIELD_CONTENT);
    await expect(readContentShape("recipe", read, await northfield())).rejects.toThrow(
      /no document type named "recipe".*resource, topic, coach/,
    );
    expect(recorded.seen).toEqual([]);
  });

  it("sends only GETs, and the token rides in a header, never in the address", async () => {
    const token = ["sk", "viewer", "Northfield0123456789abcdef"].join("_");
    const { read, recorded } = readerFor(
      { ...NORTHFIELD_CONTENT, token },
      { ...ENV, SANITY_TOKEN: token },
    );
    await readContentShape("resource", read, await northfield());
    expect(recorded.seen.every((s) => s.method === "GET")).toBe(true);
    expect(recorded.seen[0]?.url).not.toContain(token);
    expect(recorded.seen[0]?.headers.authorization).toBe(`Bearer ${token}`);
  });

  it("refuses a type name that is not one and a sample that is not a whole number, before any request", async () => {
    const { read, recorded } = readerFor(NORTHFIELD_CONTENT);
    const schema = await northfield();
    await expect(readContentShape('a" || true //', read, schema)).rejects.toThrow(
      /not a Sanity document type name/,
    );
    for (const bad of [0, -1, 1.5, 1001, Number.NaN])
      await expect(readContentShape("resource", read, schema, bad)).rejects.toThrow(/sample/);
    expect(recorded.seen).toEqual([]);
  });

  it("nested fields are counted over their parent: an object's over its own values, an array's over its items", async () => {
    const schema = schemaOf(
      doc("page", {
        title: A(STR),
        seo: A({ type: "object", attributes: { title: A(STR), note: A(STR, true) } }, true),
        sections: A(
          {
            type: "array",
            of: {
              type: "object",
              attributes: {
                _type: A({ type: "string", value: "section" }),
                heading: A(STR),
                note: A(STR, true),
                author: A(ref("author"), true),
                related: A({ type: "array", of: ref("page") }, true),
              },
            },
          },
          true,
        ),
      }),
    );
    const pages = [
      {
        _id: "p1",
        _type: "page",
        _updatedAt: "2026-10-04",
        title: "a",
        seo: { title: "x", note: "y" },
        sections: [
          { heading: "h", note: "n", author: { _type: "reference", _ref: "a1" } },
          { heading: "h" },
        ],
      },
      {
        _id: "p2",
        _type: "page",
        _updatedAt: "2026-10-03",
        title: "b",
        seo: { title: "x" },
        sections: [{ heading: "h" }],
      },
      { _id: "p3", _type: "page", _updatedAt: "2026-10-02", title: "c" },
      {
        _id: "p4",
        _type: "page",
        _updatedAt: "2026-10-01",
        title: "d",
        seo: { title: "x" },
        sections: [{ heading: "h", related: [{ _type: "reference", _ref: "p1" }] }],
      },
    ];
    const { read } = readerFor({ types: {}, content: { page: pages } });
    const shape = await readContentShape("page", read, schema);
    expect(shape.sampled).toBe(4);
    const seo = shape.fields.find((x) => x.name === "seo");
    expect(seo).toMatchObject({ kind: "object", present: 3, instances: 3 });
    expect(seo?.of?.map((x) => [x.name, x.present])).toEqual([
      ["title", 3],
      ["note", 1],
    ]);
    const sections = shape.fields.find((x) => x.name === "sections");
    expect(sections).toMatchObject({ kind: "array", item: "object", present: 3, instances: 4 });
    expect(sections?.of?.map((x) => [x.name, x.kind, x.present])).toEqual([
      ["heading", "string", 4],
      ["note", "string", 1],
      ["author", "reference", 1],
      ["related", "array", 1],
    ]);
    const q = suggestQuery(shape);
    expect(q).toContain("// seo is present on 75% of the sample");
    expect(q).toContain("// seo.note is present on 33% of the documents that have seo");
    expect(q).toContain("// sections.note is present on 25% of the sections items");
    expect(q).toContain('author->{ _id, title, "slug": slug.current }');
    expect(q).toContain('related[]->{ _id, title, "slug": slug.current }');
    expect(() => parse(q)).not.toThrow();
  });

  it("a field the schema lets be two kinds is mixed, and a union's null is not a kind", async () => {
    const schema = schemaOf(
      doc("post", {
        title: A(STR),
        credit: A(
          { type: "union", of: [STR, { type: "object", attributes: { name: A(STR) } }] },
          true,
        ),
        subtitle: A({ type: "union", of: [STR, { type: "null" }] }, true),
        gallery: A(
          {
            type: "array",
            of: { type: "union", of: [ref("post"), { type: "object", attributes: { x: A(STR) } }] },
          },
          true,
        ),
      }),
    );
    const { read } = readerFor({
      types: {},
      content: {
        post: [{ _id: "a", _type: "post", _updatedAt: "2026-10-01", title: "t", credit: "c" }],
      },
    });
    const shape = await readContentShape("post", read, schema);
    const by = Object.fromEntries(shape.fields.map((x) => [x.name, x]));
    expect(by.credit).toMatchObject({ kind: "string", mixed: ["string", "object"], present: 1 });
    expect(by.subtitle).toMatchObject({ kind: "string", present: 0 });
    expect(by.subtitle?.mixed).toBeUndefined();
    expect(by.gallery).toMatchObject({ kind: "array", itemsMixed: ["reference", "object"] });
    const q = suggestQuery(shape);
    expect(q).toContain("// credit can be a string or an object (the schema allows both)");
    expect(q).toContain(
      "// subtitle is in the schema and on none of the sample, so it is left out",
    );
  });

  it("a wide type is counted in two or more requests when one address would be too long", async () => {
    const names = Array.from({ length: 90 }, (_, i) => `a_rather_long_field_name_number_${i}`);
    const schema = schemaOf(doc("wide", Object.fromEntries(names.map((n) => [n, A(STR, true)]))));
    const item = Object.fromEntries(names.filter((_, i) => i % 3 === 0).map((n) => [n, "v"]));
    const { read, recorded } = readerFor({
      types: {},
      content: { wide: [{ _id: "w1", _type: "wide", _updatedAt: "2026-10-01", ...item }] },
    });
    const shape = await readContentShape("wide", read, schema);
    expect(recorded.seen.length).toBeGreaterThan(1);
    for (const s of recorded.seen) expect(s.url.length).toBeLessThanOrEqual(8000);
    expect(shape.fields).toHaveLength(90);
    expect(shape.fields.filter((x) => x.present === 1)).toHaveLength(30);
  });

  it("leaves out a schema field whose name cannot be written plainly, and counts it", async () => {
    const schema = schemaOf(
      doc("page", { title: A(STR), in: A(STR, true), "bad-name": A(STR, true) }),
    );
    const { read } = readerFor({
      types: {},
      content: { page: [{ _id: "p", _type: "page", _updatedAt: "2026-10-01", title: "t" }] },
    });
    const shape = await readContentShape("page", read, schema);
    expect(shape.fields.map((x) => x.name)).toEqual(["title"]);
    expect(shape.skipped).toBe(2);
  });

  it("an image's own fields other than alt are counted over the images, and a file's too", async () => {
    const image = {
      type: "object",
      attributes: {
        asset: A(ref("sanity.imageAsset"), true),
        alt: A(STR, true),
        caption: A(STR, true),
        _type: A({ type: "string", value: "image" }),
      },
    };
    const schema = schemaOf(
      doc("shop", { photo: A(image, true), gallery: A({ type: "array", of: image }, true) }),
    );
    const img = (extra: object) => ({
      _type: "image",
      asset: { _type: "reference", _ref: "image-x-1x1-png" },
      ...extra,
    });
    const { read } = readerFor({
      types: {},
      content: {
        shop: [
          {
            _id: "s1",
            _type: "shop",
            _updatedAt: "2026-10-02",
            photo: img({ caption: "c", alt: "a" }),
            gallery: [img({}), img({ caption: "c" })],
          },
          { _id: "s2", _type: "shop", _updatedAt: "2026-10-01", photo: img({}) },
        ],
      },
    });
    const shape = await readContentShape("shop", read, schema);
    const photo = shape.fields.find((x) => x.name === "photo");
    expect(photo?.of?.map((x) => [x.name, x.present])).toEqual([["caption", 1]]);
    const gallery = shape.fields.find((x) => x.name === "gallery");
    expect(gallery).toMatchObject({ item: "image", instances: 2 });
    const q = suggestQuery(shape);
    expect(q).toContain(
      [
        "  photo{",
        '    "url": asset->url,',
        '    "alt": coalesce(alt, ""),',
        '    "caption": coalesce(caption, "")',
        "  },",
      ].join("\n"),
    );
    expect(q).toContain("// photo.caption is present on 50% of the documents that have photo");
  });
});

describe("--suggest promise: no document and no field value is requested, returned or printed", () => {
  it("no marker string is in the request log, the recorded responses, the shape or the query", async () => {
    const { read, recorded } = readerFor(NORTHFIELD_CONTENT);
    const shape = await readContentShape("resource", read, await readSchemaFileFull(SCHEMA_FILE));
    const query = suggestQuery(shape);
    const everything = JSON.stringify({ recorded, shape, query }).toLowerCase();
    expect(everything).not.toContain(CONTENT_MARKER.toLowerCase());
    // Not an asset id or a reference id either: those are values too.
    expect(everything).not.toMatch(/image-|file-northfield|topic-\d/);
  });

  it("every request is a GET of count() calls: no projection, no document, no field read", async () => {
    const { read, recorded } = readerFor(NORTHFIELD_CONTENT);
    await readContentShape("resource", read, await readSchemaFileFull(SCHEMA_FILE));
    for (const s of recorded.seen) {
      expect(s.method).toBe("GET");
      const tree = parse(s.query) as unknown as {
        type: string;
        attributes: { value: { name?: string } }[];
      };
      expect(tree.type).toBe("Object");
      for (const a of tree.attributes) expect(a.value.name).toBe("count");
    }
  });
});
