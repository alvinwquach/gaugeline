import { evaluate, parse } from "groq-js";
import { describe, expect, it } from "vitest";
import {
  sanityCountsTransport,
  type FakeSanity,
  type SeenSanityRequest,
} from "../../../../testkit/src/index.js";
import { createSanityRead, type SanityRead } from "../../connectors/sanity.js";
import { ConnectorRefusedError } from "../../connectors/http.js";
import { createFetcher } from "../../fetcher.js";
import {
  buildCountQuery,
  compareWithCounts,
  countedPath,
  countedPaths,
  fetchCounts,
  type TypeCounts,
} from "../counts.js";
import type { FieldUse, QueryShape } from "../shape.js";

const TOKEN = ["sk", "viewer", "Copperhill0123456789abcdef"].join("_");

function shape(
  type: string,
  paths: string[],
  at: { file?: string; line?: number } = {},
  excludesDrafts = true,
): QueryShape {
  const source = { file: at.file ?? "src/a.ts", line: at.line ?? 3 };
  return {
    type,
    fields: paths.map((path): FieldUse => ({ path, deref: path.includes("->"), source })),
    excludesDrafts,
    params: [],
    source,
  };
}

const counts = (
  type: string,
  total: number,
  defined: Record<string, number> = {},
): Map<string, TypeCounts> =>
  new Map([[type, { type, total, defined: new Map(Object.entries(defined)) }]]);

describe("buildCountQuery: unit", () => {
  const query = buildCountQuery("resource", ["title", "slug.current", "gatedFile"]);

  it("a resource with 3 paths", () => {
    expect(query).toMatchInlineSnapshot(
      `"{"total":count(*[_type == "resource"]),"p0":count(*[_type == "resource" && defined(title)]),"p1":count(*[_type == "resource" && defined(slug.current)]),"p2":count(*[_type == "resource" && defined(gatedFile)])}"`,
    );
  });

  it("is one object of count() calls and projects no field value", () => {
    expect(query).toContain("count(");
    expect(query).toContain("defined(");
    const tree = parse(query) as unknown as {
      type: string;
      attributes: { value: { type: string; name?: string } }[];
    };
    expect(tree.type).toBe("Object");
    expect(tree.attributes).toHaveLength(4);
    for (const a of tree.attributes)
      expect(a.value).toMatchObject({ type: "FuncCall", name: "count" });
  });

  it("counts a reference field and an array field, not what is inside it", () => {
    expect(countedPath("topic->title")).toBe("topic");
    expect(countedPath("photo.asset->url")).toBe("photo.asset");
    expect(countedPath("sections[].heading")).toBe("sections");
    expect(countedPath("lines[].item->name")).toBe("lines");
    expect(countedPath("allergens[]->name")).toBe("allergens");
    expect(countedPath("slug.current")).toBe("slug.current");
  });

  it("leaves out the fields every document has", () => {
    for (const p of ["_id", "_type", "_rev", "_createdAt", "_updatedAt"])
      expect(countedPath(p)).toBeNull();
    expect(countedPath("sections[]._type")).toBe("sections");
    expect(countedPaths(["_id", "topic->title", "topic->slug.current", "topic", "title"])).toEqual([
      "topic",
      "title",
    ]);
  });

  it("asks the same thing once however many queries name a field", () => {
    expect(buildCountQuery("post", ["title", "title", "venue->name", "venue->address.city"])).toBe(
      buildCountQuery("post", ["title", "venue"]),
    );
  });
});

describe("buildCountQuery against documents (groq-js)", () => {
  /** What Sanity would answer: the query run over invented published documents. */
  async function ask(query: string, dataset: unknown[]): Promise<Record<string, number>> {
    const value = await evaluate(parse(query), { dataset });
    return (await value.get()) as Record<string, number>;
  }

  it("total 5, with 3 having a nested field and 2 a reference", async () => {
    const dataset = [
      { _id: "1", _type: "resource", slug: { current: "a" }, topic: { _ref: "t" } },
      { _id: "2", _type: "resource", slug: { current: "b" }, topic: { _ref: "t" } },
      { _id: "3", _type: "resource", slug: { current: "c" } },
      { _id: "4", _type: "resource", slug: {} },
      { _id: "5", _type: "resource" },
      { _id: "6", _type: "topic", slug: { current: "x" } },
    ];
    const result = await ask(
      buildCountQuery("resource", ["slug.current", "topic->title"]),
      dataset,
    );
    expect(result).toEqual({ total: 5, p0: 3, p1: 2 });
  });

  it("quotes a field with a hyphen, a reserved word, a space or a quote in its name", async () => {
    const odd = ["gated-file", "in", "null", "match", "two words", 'say "hi"', "naïve", "a.b-c"];
    const dataset = [
      {
        _id: "1",
        _type: "x",
        "gated-file": 1,
        in: 1,
        null: 1,
        match: 1,
        "two words": 1,
        'say "hi"': 1,
        naïve: 1,
        a: { "b-c": 1 },
      },
      { _id: "2", _type: "x", "gated-file": 1 },
    ];
    const result = await ask(buildCountQuery("x", odd), dataset);
    expect(result).toEqual({ total: 2, p0: 2, p1: 1, p2: 1, p3: 1, p4: 1, p5: 1, p6: 1, p7: 1 });
  });

  it("quotes a type name too", async () => {
    const dataset = [{ _id: "1", _type: 'odd"type' }];
    expect(await ask(buildCountQuery('odd"type', []), dataset)).toEqual({ total: 1 });
  });

  it("a type with no fields is a total alone", () => {
    expect(buildCountQuery("page", ["_id"])).toBe('{"total":count(*[_type == "page"])}');
  });
});

describe("compareWithCounts: unit", () => {
  it("40 documents and 12 with the field: missing on 28 of 40", () => {
    const found = compareWithCounts(
      [shape("resource", ["gatedFile"], { file: "src/r.ts", line: 9 })],
      counts("resource", 40, { gatedFile: 12 }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "query-field-partial",
      severity: "low",
      source: { file: "src/r.ts", line: 9 },
    });
    expect(found[0]?.evidence).toContain("gatedFile is missing on 28 of 40 documents");
    expect(found[0]?.evidence).toContain("src/r.ts:9");
  });

  it("a field on no document of a type that has some is high", () => {
    const found = compareWithCounts(
      [shape("resource", ["author"])],
      counts("resource", 40, { author: 0 }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checkId: "query-field-absent", severity: "high" });
    expect(found[0]?.evidence).toContain("author doesn't exist on any resource");
  });

  it("total 0 gives one type finding and no field findings", () => {
    const found = compareWithCounts(
      [shape("topic", ["title", "slug.current", "body"])],
      counts("topic", 0, { title: 0, "slug.current": 0, body: 0 }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checkId: "query-type-empty", severity: "high" });
    expect(found[0]?.evidence).toContain("Nothing of type topic exists");
  });

  it("a field on every document is not a finding", () => {
    expect(
      compareWithCounts([shape("post", ["title", "_id"])], counts("post", 7, { title: 7 })),
    ).toEqual([]);
  });

  it("the same field used by two queries gives two findings, one per file and line", () => {
    const found = compareWithCounts(
      [
        shape("resource", ["author"], { file: "src/a.ts", line: 3 }),
        shape("resource", ["author", "title"], { file: "src/b.ts", line: 8 }),
      ],
      counts("resource", 10, { author: 0 }),
    );
    expect(found.map((f) => f.source)).toEqual([
      { file: "src/a.ts", line: 3 },
      { file: "src/b.ts", line: 8 },
    ]);
  });

  it("a reference counts the reference field, once, however many of its fields are read", () => {
    const found = compareWithCounts(
      [shape("resource", ["topic->title", "topic->slug.current"])],
      counts("resource", 40, { topic: 0 }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain("topic doesn't exist on any resource");
  });

  it("a query that does not leave drafts out is medium, and needs no count", () => {
    const found = compareWithCounts([shape("post", ["title"], {}, false)], new Map());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checkId: "query-no-drafts-filter", severity: "medium" });
  });

  it("a type with no counts is not reported as empty", () => {
    expect(compareWithCounts([shape("post", ["title"])], new Map())).toEqual([]);
  });

  it("an empty type with no drafts filter gets both findings", () => {
    const found = compareWithCounts([shape("post", ["title"], {}, false)], counts("post", 0));
    expect(found.map((f) => f.checkId).sort()).toEqual([
      "query-no-drafts-filter",
      "query-type-empty",
    ]);
  });
});

function sanity(spec: FakeSanity, env: Record<string, string> = {}) {
  const seen: SeenSanityRequest[] = [];
  const read = createSanityRead(
    { SANITY_PROJECT_ID: "cprhl1b4", SANITY_DATASET: "production", ...env },
    createFetcher({ transport: sanityCountsTransport(spec, seen), timeoutMs: 5000 }),
  );
  return { read, seen };
}

describe("fetchCounts: integration (recorded-shape Sanity answers)", () => {
  it("a renamed field: one high finding with file and line", async () => {
    const { read } = sanity({
      types: { popup: { total: 12, defined: { startsAt: 12, date: 0 } } },
    });
    const shapes = [
      shape("popup", ["title", "date"], { file: "src/app/events/page.tsx", line: 3 }),
    ];
    const found = compareWithCounts(shapes, await fetchCounts(shapes, read));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "query-field-absent",
      severity: "high",
      source: { file: "src/app/events/page.tsx", line: 3 },
    });
  });

  it("5 queries over 2 types make exactly 2 requests", async () => {
    const { read, seen } = sanity({
      types: { menuItem: { total: 40, defined: { allergens: 28 } }, popup: { total: 12 } },
    });
    const shapes = [
      shape("menuItem", ["name", "allergens[]->name"], { line: 3 }),
      shape("menuItem", ["name", "price"], { line: 10 }),
      shape("popup", ["title", "date"], { line: 20 }),
      shape("popup", ["title", "venue->name"], { line: 30 }),
      shape("menuItem", ["_id"], { line: 40 }),
    ];
    const got = await fetchCounts(shapes, read);
    const hits = new Map<string, number>();
    for (const r of seen) hits.set(r.type ?? "?", (hits.get(r.type ?? "?") ?? 0) + 1);
    expect(hits).toEqual(
      new Map([
        ["menuItem", 1],
        ["popup", 1],
      ]),
    );
    expect([...got.keys()]).toEqual(["menuItem", "popup"]);
    expect(got.get("menuItem")).toEqual({
      type: "menuItem",
      total: 40,
      defined: new Map([
        ["name", 40],
        ["allergens", 28],
        ["price", 40],
      ]),
    });
  });

  it("a type that does not exist comes back with total 0", async () => {
    const { read } = sanity({ types: {} });
    const got = await fetchCounts([shape("topic", ["title"])], read);
    expect(got.get("topic")?.total).toBe(0);
  });

  it("a type with 60 field paths makes one request, under the address limit", async () => {
    const { read, seen } = sanity({ types: { resource: { total: 9 } } });
    const paths = Array.from({ length: 60 }, (_, i) => `field_${i}`);
    const logged: string[] = [];
    const got = await fetchCounts([shape("resource", paths)], read, { log: (m) => logged.push(m) });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url.length).toBeLessThan(8000);
    expect(got.get("resource")?.defined.size).toBe(60);
    expect(logged).toEqual([]);
  });

  it("a type with more paths than fit is sent in halves, and that is logged", async () => {
    const { read, seen } = sanity({
      types: { resource: { total: 9, defined: { f_000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 4 } } },
    });
    const paths = Array.from(
      { length: 150 },
      (_, i) => `f_${String(i).padStart(3, "0")}_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    );
    const logged: string[] = [];
    const got = await fetchCounts([shape("resource", paths)], read, { log: (m) => logged.push(m) });
    expect(seen.length).toBeGreaterThan(1);
    for (const r of seen) expect(r.url.length).toBeLessThanOrEqual(8000);
    expect(got.get("resource")?.total).toBe(9);
    expect(got.get("resource")?.defined.size).toBe(150);
    expect(got.get("resource")?.defined.get("f_000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(4);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("resource");
    expect(logged[0]).toContain("150");
  });

  it("a field path too long for any request is an error that names the type", async () => {
    const { read } = sanity({ types: {} });
    const huge = `x${"y".repeat(9000)}`;
    await expect(fetchCounts([shape("resource", [huge])], read)).rejects.toThrow(/resource/);
  });

  it("an answer that is not integers is refused", async () => {
    const read: SanityRead = {
      query: () => Promise.resolve({ total: 40, p0: "12" }),
      dataset: "production",
      datasetAssumed: false,
    };
    await expect(fetchCounts([shape("resource", ["a"])], read)).rejects.toThrow(/not a count/);
    const fractional: SanityRead = { ...read, query: () => Promise.resolve({ total: 4.5 }) };
    await expect(fetchCounts([shape("resource", ["a"])], fractional)).rejects.toThrow(
      /not a count/,
    );
  });
});

describe("the Sanity reader: edge cases", () => {
  it("a private dataset with no token: the message names SANITY_TOKEN and the Viewer role", async () => {
    const { read } = sanity({ types: {}, token: true });
    const err = await fetchCounts([shape("post", ["title"])], read).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorRefusedError);
    expect((err as ConnectorRefusedError).message).toContain("SANITY_TOKEN");
    expect((err as ConnectorRefusedError).message).toContain("Viewer");
  });

  it("a token Sanity does not accept is said differently, and never printed", async () => {
    const { read } = sanity({ types: {}, token: "another" }, { SANITY_TOKEN: TOKEN });
    const err = (await fetchCounts([shape("post", ["title"])], read).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toContain("did not accept SANITY_TOKEN");
    expect(err.message).not.toContain(TOKEN);
  });

  it("SANITY_DATASET unset falls back to production and says so", () => {
    const seen: SeenSanityRequest[] = [];
    const read = createSanityRead(
      { SANITY_PROJECT_ID: "cprhl1b4" },
      createFetcher({ transport: sanityCountsTransport({ types: {} }, seen) }),
    );
    expect(read.dataset).toBe("production");
    expect(read.datasetAssumed).toBe(true);
  });

  it("SANITY_DATASET set is used as it is", async () => {
    const { read, seen } = sanity({ types: {} }, { SANITY_DATASET: "staging" });
    expect(read.datasetAssumed).toBe(false);
    await fetchCounts([shape("post", ["title"])], read);
    expect(seen[0]?.url).toContain("/data/query/staging?");
  });

  it("SANITY_PROJECT_ID unset is named", () => {
    expect(() => createSanityRead({}, createFetcher())).toThrow(/SANITY_PROJECT_ID/);
  });
});

describe("the promise: counts only, GET only, no token in sight", () => {
  it("every request is a GET for published documents, with the token in a header only", async () => {
    const { read, seen } = sanity(
      { types: { post: { total: 3, defined: { title: 2 } }, popup: { total: 1 } }, token: TOKEN },
      { SANITY_TOKEN: TOKEN },
    );
    await fetchCounts([shape("post", ["title"]), shape("popup", ["date"])], read);
    expect(seen).toHaveLength(2);
    for (const r of seen) {
      expect(r.method).toBe("GET");
      expect(r.url).toContain("perspective=published");
      expect(r.url).not.toContain(TOKEN);
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("what the check keeps is integers: a Map of integers, and findings with no value in them", async () => {
    const { read } = sanity({ types: { post: { total: 3, defined: { title: 0 } } } });
    const got = await fetchCounts([shape("post", ["title", "body"])], read);
    for (const t of got.values()) {
      expect(Number.isInteger(t.total)).toBe(true);
      for (const n of t.defined.values()) expect(Number.isInteger(n)).toBe(true);
    }
  });
});
