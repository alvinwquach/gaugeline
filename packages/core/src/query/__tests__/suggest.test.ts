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
import { createFetcher } from "../../fetcher.js";
import { readContentShape, type ContentShape, type FieldShape } from "../content-shape.js";
import { suggestQuery } from "../suggest.js";

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

  it("a field that is a string on some documents and an object on others is written plainly, with a comment naming both kinds", () => {
    const q = suggestQuery(
      shaped([f("notes", "string", 12, { mixed: ["string", "object"] }), f("title", "string", 12)]),
    );
    expect(q).toContain("// notes is a string on some documents and an object on others");
    expect(q).toContain("\n  notes,\n");
    expect(q).not.toContain("coalesce(notes");
  });

  it("three kinds are all named", () => {
    const q = suggestQuery(
      shaped([f("value", "string", 12, { mixed: ["string", "number", "object"] })]),
    );
    expect(q).toContain("// value is a string, a number or an object, depending on the document");
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

const ENV = { SANITY_PROJECT_ID: "northfield", SANITY_DATASET: "production" };

function readerFor(spec: FakeSanity, seen: SeenSanityRequest[] = []) {
  return createSanityRead(
    ENV,
    createFetcher({ transport: sanityCountsTransport(spec, seen), timeoutMs: 5000 }),
  );
}

describe("readContentShape: integration (invented Sanity responses)", () => {
  it("12 documents: the kinds of slug, reference, image, file and Portable Text are right", async () => {
    const shape = await readContentShape("resource", readerFor(NORTHFIELD_CONTENT));
    expect(shape.type).toBe("resource");
    expect(shape.sampled).toBe(12);
    const kinds = Object.fromEntries(shape.fields.map((x) => [x.name, x.kind]));
    expect(kinds).toEqual({
      title: "string",
      slug: "slug",
      summary: "string",
      topic: "reference",
      body: "portable-text",
      heroImage: "image",
      tags: "array",
      publishedAt: "string",
      gatedFile: "file",
    });
    const present = Object.fromEntries(shape.fields.map((x) => [x.name, x.present]));
    expect(present).toMatchObject({ title: 12, publishedAt: 6, gatedFile: 4, heroImage: 12 });
    expect(shape.fields.find((x) => x.name === "tags")?.item).toBe("string");
    expect(shape.fields.find((x) => x.name === "heroImage")?.of).toEqual([
      expect.objectContaining({ name: "alt", kind: "string", present: 6 }),
    ]);
  });

  it("drafts are left out: a field only a draft has is not in the shape", async () => {
    const shape = await readContentShape("resource", readerFor(NORTHFIELD_CONTENT));
    expect(shape.fields.map((x) => x.name)).not.toContain("draftOnly");
    expect(shape.sampled).toBe(12);
  });

  it("the shape fed to suggestQuery gives the docs example", async () => {
    const shape = await readContentShape("resource", readerFor(NORTHFIELD_CONTENT));
    expect(suggestQuery(shape)).toBe(DOCS_EXAMPLE);
  });

  it("asks for the newest 50 by default, and for the sample it is given", async () => {
    const seen: SeenSanityRequest[] = [];
    await readContentShape("resource", readerFor(NORTHFIELD_CONTENT, seen));
    await readContentShape("resource", readerFor(NORTHFIELD_CONTENT, seen), 5);
    expect(seen.map((s) => s.query)).toEqual([
      '*[_type == "resource" && !(_id in path("drafts.**"))] | order(_updatedAt desc)[0...50]',
      '*[_type == "resource" && !(_id in path("drafts.**"))] | order(_updatedAt desc)[0...5]',
    ]);
    for (const s of seen) expect(() => parse(s.query)).not.toThrow();
  });

  it("a sample of 5 reads the 5 newest documents and says 5", async () => {
    const shape = await readContentShape("resource", readerFor(NORTHFIELD_CONTENT), 5);
    expect(shape.sampled).toBe(5);
    // The newest five are resource-01 .. resource-05: gatedFile is on 4 of them.
    expect(shape.fields.find((x) => x.name === "gatedFile")?.present).toBe(4);
    expect(shape.fields.find((x) => x.name === "publishedAt")?.present).toBe(5);
  });

  it("a type with fewer documents than the sample says the real number", async () => {
    const shape = await readContentShape("resource", readerFor(NORTHFIELD_CONTENT), 200);
    expect(shape.sampled).toBe(12);
    expect(suggestQuery(shape).split("\n")[0]).toBe(
      "// resource, written from 12 published documents",
    );
  });

  it("a type with no documents is a shape of none", async () => {
    const shape = await readContentShape("topic", readerFor(NORTHFIELD_CONTENT));
    expect(shape).toEqual({ type: "topic", sampled: 0, fields: [] });
  });

  it("sends only GETs, and the token never rides in the address", async () => {
    const seen: SeenSanityRequest[] = [];
    const token = ["sk", "viewer", "Northfield0123456789abcdef"].join("_");
    const read = createSanityRead(
      { ...ENV, SANITY_TOKEN: token },
      createFetcher({
        transport: sanityCountsTransport({ ...NORTHFIELD_CONTENT, token }, seen),
        timeoutMs: 5000,
      }),
    );
    await readContentShape("resource", read);
    expect(seen).toHaveLength(1);
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    expect(seen[0]?.url).not.toContain(token);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${token}`);
  });

  it("halves the sample when the documents are too long for one answer, and says the number it read", async () => {
    const seen: SeenSanityRequest[] = [];
    const shape = await readContentShape(
      "resource",
      readerFor({ ...NORTHFIELD_CONTENT, carryDocuments: 6 }, seen),
      12,
    );
    expect(shape.sampled).toBe(6);
    expect(seen.map((s) => /\[0\.\.\.(\d+)\]$/.exec(s.query)?.[1])).toEqual(["12", "6"]);
  });

  it("refuses a type name that is not one, before any request", async () => {
    const seen: SeenSanityRequest[] = [];
    await expect(
      readContentShape('a" || true //', readerFor(NORTHFIELD_CONTENT, seen)),
    ).rejects.toThrow(/not a Sanity document type name/);
    expect(seen).toEqual([]);
  });

  it("refuses a sample that is not a whole number from 1 to 200", async () => {
    for (const bad of [0, -1, 1.5, 201, Number.NaN])
      await expect(
        readContentShape("resource", readerFor(NORTHFIELD_CONTENT), bad),
      ).rejects.toThrow(/sample/);
  });

  it("reads kinds from invented documents of every shape, and ignores null and system keys", async () => {
    const spec: FakeSanity = {
      types: {},
      content: {
        page: [
          {
            _id: "page-1",
            _type: "page",
            _updatedAt: "2026-10-02T00:00:00Z",
            _rev: "r1",
            title: "a",
            count: 3,
            live: true,
            gone: null,
            sections: [
              { _type: "hero", _key: "k1", heading: "h", cta: { _type: "reference", _ref: "x" } },
              { _type: "hero", _key: "k2", heading: "h" },
            ],
            meta: {
              _type: "seo",
              noindex: false,
              nested: { deep: { deeper: { deepest: { x: 1 } } } },
            },
            mixed: "text",
          },
          {
            _id: "page-2",
            _type: "page",
            _updatedAt: "2026-10-01T00:00:00Z",
            title: "b",
            mixed: { a: 1 },
          },
        ],
      },
    };
    const shape = await readContentShape("page", readerFor(spec));
    expect(shape.sampled).toBe(2);
    expect(shape.fields.map((x) => x.name)).toEqual([
      "title",
      "count",
      "live",
      "sections",
      "meta",
      "mixed",
    ]);
    const by = Object.fromEntries(shape.fields.map((x) => [x.name, x]));
    expect(by.count).toMatchObject({ kind: "number", present: 1 });
    expect(by.live).toMatchObject({ kind: "boolean", present: 1 });
    expect(by.sections).toMatchObject({ kind: "array", item: "object", present: 1, instances: 2 });
    expect(by.sections?.of?.map((x) => [x.name, x.kind, x.present])).toEqual([
      ["heading", "string", 2],
      ["cta", "reference", 1],
    ]);
    expect(by.mixed).toMatchObject({ kind: "string", present: 2, mixed: ["string", "object"] });
    expect(by.meta?.of?.map((x) => x.name)).toEqual(["noindex", "nested"]);
  });

  it("leaves out a field whose name cannot be written plainly, and counts it", async () => {
    const spec: FakeSanity = {
      types: {},
      content: {
        page: [
          {
            _id: "p1",
            _type: "page",
            _updatedAt: "2026-10-01T00:00:00Z",
            title: "a",
            'x"] || true //': "b",
            "bad\u202Ename": "c",
          },
        ],
      },
    };
    const shape = await readContentShape("page", readerFor(spec));
    expect(shape.fields.map((x) => x.name)).toEqual(["title"]);
    expect(shape.skipped).toBe(2);
  });
});

describe("--suggest promise: no field value leaves the machine or reaches the output", () => {
  it("no marker string is in the request log, the shape or the query", async () => {
    const seen: SeenSanityRequest[] = [];
    const shape = await readContentShape("resource", readerFor(NORTHFIELD_CONTENT, seen));
    const query = suggestQuery(shape);
    const everything = JSON.stringify({ seen, shape, query });
    expect(everything).not.toContain(CONTENT_MARKER);
    expect(everything.toLowerCase()).not.toContain(CONTENT_MARKER.toLowerCase());
    // Not an asset id or a reference id either: those are values too.
    expect(everything).not.toMatch(/image-|file-NORTH|topic-\d/);
  });

  it("the request is a GET of a query that projects no field", async () => {
    const seen: SeenSanityRequest[] = [];
    await readContentShape("resource", readerFor(NORTHFIELD_CONTENT, seen));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.query).not.toContain("{");
    expect(new URL(seen[0]?.url ?? "").searchParams.get("perspective")).toBe("published");
  });
});
