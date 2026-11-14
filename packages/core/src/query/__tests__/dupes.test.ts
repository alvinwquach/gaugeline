import { evaluate, parse } from "groq-js";
import { describe, expect, it } from "vitest";
import {
  sanityCountsTransport,
  type FakeSanity,
  type SeenSanityRequest,
} from "../../../../testkit/src/index.js";
import { createDupesRegistry, QUERY_DUPE_CHECKS } from "../../checks/query-dupes.js";
import { createSanityRead, type SanityRead } from "../../connectors/sanity.js";
import { createFetcher } from "../../fetcher.js";
import { resultSchema } from "../../result.js";
import { runChecks } from "../../run.js";
import { dupeFindings, dupesQuery, findDupes, type DupeGroup } from "../dupes.js";
import { compareQueries } from "../run.js";
import type { QueryShape } from "../shape.js";

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const TOKEN = ["sk", "viewer", "Copperhill0123456789abcdef"].join("_");

interface Doc {
  _id: string;
  slug?: string | null;
  title?: unknown;
}

/** A reader that answers each type's query with the rows it is given, and remembers what it was asked. */
function reader(rows: Record<string, unknown>, asked: string[] = []): SanityRead {
  return {
    dataset: "production",
    datasetAssumed: false,
    query: (groq) => {
      asked.push(groq);
      const type = /_type == "([^"]*)"/.exec(groq)?.[1] ?? "";
      return Promise.resolve(rows[type] ?? []);
    },
  };
}

const row = (d: Doc) => ({ _id: d._id, slug: d.slug ?? null, title: d.title ?? null });

const RESOURCES: Doc[] = [
  { _id: "res-1", slug: "claim-denials", title: "Claim denials" },
  { _id: "res-2", slug: "claim-denials", title: "How to appeal a denial" },
  { _id: "res-3", slug: "mips-guide", title: "MIPS guide" },
  { _id: "res-4", slug: "mips-2026", title: "MIPS guide" },
  { _id: "res-5", slug: "alone", title: "Only one of me" },
];

describe("findDupes: unit", () => {
  it("res-1 and res-2 share a slug, res-3 and res-4 share a title, res-5 is alone: two groups", async () => {
    const groups = await findDupes(["resource"], reader({ resource: RESOURCES.map(row) }));
    expect(groups).toEqual([
      { type: "resource", key: "slug", value: "claim-denials", ids: ["res-1", "res-2"] },
      { type: "resource", key: "title", value: "MIPS guide", ids: ["res-3", "res-4"] },
    ]);
  });

  it('"MIPS guide" and " mips Guide " are one title group', async () => {
    const groups = await findDupes(
      ["resource"],
      reader({
        resource: [
          row({ _id: "a", slug: "one", title: "MIPS guide" }),
          row({ _id: "b", slug: "two", title: " mips Guide " }),
        ],
      }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "title", ids: ["a", "b"] });
  });

  it("slugs are compared exactly: a different case or a trailing space is a different address", async () => {
    const groups = await findDupes(
      ["resource"],
      reader({
        resource: [
          row({ _id: "a", slug: "Claim-Denials", title: "A" }),
          row({ _id: "b", slug: "claim-denials", title: "B" }),
          row({ _id: "c", slug: "claim-denials ", title: "C" }),
        ],
      }),
    );
    expect(groups).toEqual([]);
  });

  it("ids are sorted, whatever order Sanity answered in", async () => {
    const groups = await findDupes(
      ["resource"],
      reader({
        resource: ["res-9", "res-10", "res-2", "res-1"].map((_id, i) =>
          row({ _id, slug: "same", title: `Title ${i}` }),
        ),
      }),
    );
    expect(groups[0]?.ids).toEqual(["res-1", "res-10", "res-2", "res-9"]);
  });

  it("the title shown is the one of the document with the lowest id, in any answer order", async () => {
    const docs = [
      row({ _id: "b", slug: "x", title: "  Seeded RYE " }),
      row({ _id: "a", slug: "y", title: "seeded rye" }),
    ];
    for (const rows of [docs, [...docs].reverse()]) {
      const groups = await findDupes(["menuItem"], reader({ menuItem: rows }));
      expect(groups[0]?.value).toBe("seeded rye");
    }
  });

  it("a group that shares both slug and title is reported once, as the slug group", async () => {
    const groups = await findDupes(
      ["resource"],
      reader({
        resource: [
          row({ _id: "a", slug: "same", title: "Same" }),
          row({ _id: "b", slug: "same", title: "same" }),
        ],
      }),
    );
    expect(groups).toEqual([{ type: "resource", key: "slug", value: "same", ids: ["a", "b"] }]);
  });

  it("a title group wider than the slug group it contains is still reported", async () => {
    const groups = await findDupes(
      ["resource"],
      reader({
        resource: [
          row({ _id: "a", slug: "same", title: "Same" }),
          row({ _id: "b", slug: "same", title: "Same" }),
          row({ _id: "c", slug: "other", title: "Same" }),
        ],
      }),
    );
    expect(groups.map((g) => [g.key, g.ids])).toEqual([
      ["slug", ["a", "b"]],
      ["title", ["a", "b", "c"]],
    ]);
  });

  it("asks once for each type, however many times a shape names it", async () => {
    const asked: string[] = [];
    await findDupes(["resource", "post", "resource"], reader({}, asked));
    expect(asked).toHaveLength(2);
  });

  it("types are kept apart, in the order they were named", async () => {
    const groups = await findDupes(
      ["post", "resource"],
      reader({
        resource: [
          row({ _id: "r1", slug: "a", title: "T" }),
          row({ _id: "r2", slug: "a", title: "U" }),
        ],
        post: [
          row({ _id: "p1", slug: "b", title: "T" }),
          row({ _id: "p2", slug: "c", title: "T" }),
        ],
      }),
    );
    expect(groups.map((g) => [g.type, g.key])).toEqual([
      ["post", "title"],
      ["resource", "slug"],
    ]);
  });
});

describe("findDupes: edge cases", () => {
  it("a type with no slug field at all gives title groups only and no error", async () => {
    const groups = await findDupes(
      ["popup"],
      reader({
        popup: [
          { _id: "p1", slug: null, title: "Saturday market" },
          { _id: "p2", slug: null, title: "saturday market" },
          { _id: "p3", slug: null, title: "Sunday market" },
        ],
      }),
    );
    expect(groups).toEqual([
      { type: "popup", key: "title", value: "Saturday market", ids: ["p1", "p2"] },
    ]);
  });

  it("documents with no slug or no title are skipped, not reported", async () => {
    const groups = await findDupes(
      ["resource"],
      reader({
        resource: [
          { _id: "a", slug: null, title: "Shared" },
          { _id: "b", slug: "", title: "Shared" },
          { _id: "c", slug: "x", title: null },
          { _id: "d", slug: "x", title: "   " },
          { _id: "e", slug: "y", title: { en: "Localised", es: "Localizado" } },
          { _id: "f", slug: "y", title: 42 },
        ],
      }),
    );
    // A document with no slug is left out of the slug groups only, and one with no title out of the
    // title groups only: a and b share a title, c and d a slug, e and f a slug.
    expect(groups.map((g) => [g.key, g.ids])).toEqual([
      ["slug", ["c", "d"]],
      ["slug", ["e", "f"]],
      ["title", ["a", "b"]],
    ]);
  });

  it("a draft and its published document are not a duplicate pair, even if Sanity sends both", async () => {
    const groups = await findDupes(
      ["resource"],
      reader({
        resource: [
          row({ _id: "res-1", slug: "claim-denials", title: "Claim denials" }),
          row({ _id: "drafts.res-1", slug: "claim-denials", title: "Claim denials" }),
        ],
      }),
    );
    expect(groups).toEqual([]);
  });

  it("a slug shared across two different types is not reported", async () => {
    const groups = await findDupes(
      ["page", "post"],
      reader({
        page: [row({ _id: "pg-1", slug: "about", title: "About" })],
        post: [row({ _id: "po-1", slug: "about", title: "About" })],
      }),
    );
    expect(groups).toEqual([]);
  });

  it("5,000 documents of one type: one request, only the one pair found, and nothing else kept", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) =>
      row({ _id: `res-${i}`, slug: `slug-${i}`, title: `Title ${i}` }),
    );
    rows[4999] = row({ _id: "res-4999", slug: "slug-0", title: "Title 4999" });
    const asked: string[] = [];
    const groups = await findDupes(["resource"], reader({ resource: rows }, asked));
    expect(asked).toHaveLength(1);
    expect(groups).toEqual([
      { type: "resource", key: "slug", value: "slug-0", ids: ["res-0", "res-4999"] },
    ]);
    // What is returned holds the ids of the groups, not a copy of the 5,000 documents.
    expect(JSON.stringify(groups).length).toBeLessThan(200);
  });

  it("rows that are not documents are ignored and an answer that is not a list is an error", async () => {
    const groups = await findDupes(
      ["resource"],
      reader({
        resource: [null, 3, { slug: "x" }, { _id: 7 }, row({ _id: "a", slug: "x", title: "T" })],
      }),
    );
    expect(groups).toEqual([]);
    await expect(findDupes(["resource"], reader({ resource: { oops: 1 } }))).rejects.toThrow(
      "not a list of documents",
    );
  });
});

describe("dupeFindings", () => {
  const slug: DupeGroup = {
    type: "resource",
    key: "slug",
    value: "claim-denials",
    ids: ["res-1", "res-2"],
  };
  const title: DupeGroup = {
    type: "resource",
    key: "title",
    value: "MIPS guide",
    ids: ["res-3", "res-4"],
  };

  it("a shared slug is high and a shared title is a warning, each naming the ids", () => {
    expect(dupeFindings([slug, title])).toEqual([
      {
        checkId: "query-dupe-slug",
        severity: "high",
        title: "2 resource documents share the slug \u201Cclaim-denials\u201D",
        evidence: "Only one can own the address. res-1, res-2",
        url: "sanity:resource",
      },
      {
        checkId: "query-dupe-title",
        severity: "medium",
        title: "2 resource documents are called \u201CMIPS guide\u201D",
        evidence: "Different addresses, same thing. res-3, res-4",
        url: "sanity:resource",
      },
    ]);
  });

  it('evidence for 14 ids shows 10 and "and 4 more"', () => {
    const ids = Array.from({ length: 14 }, (_, i) => `res-${String(i + 1).padStart(2, "0")}`);
    const [f] = dupeFindings([{ ...slug, ids }]);
    expect(f?.title).toBe("14 resource documents share the slug \u201Cclaim-denials\u201D");
    expect(f?.evidence).toBe(
      `Only one can own the address. ${ids.slice(0, 10).join(", ")}, and 4 more`,
    );
    const [ten] = dupeFindings([{ ...slug, ids: ids.slice(0, 10) }]);
    expect(ten?.evidence).not.toContain("more");
    const [eleven] = dupeFindings([{ ...slug, ids: ids.slice(0, 11) }]);
    expect(eleven?.evidence).toMatch(/, and 1 more$/);
  });

  it("an editor's text is escaped and cut: invisible characters, line breaks, length", () => {
    const [f] = dupeFindings([
      {
        ...title,
        value: `Menu\u200B\n<script>alert(1)</script>${"x".repeat(200)}`,
        ids: ["a\u202Eb", "c"],
      },
    ]);
    expect(f?.title).not.toMatch(/[\u200B\n\u202E]/);
    expect(f?.title).toContain("\\u{200B}");
    expect(f?.title.length).toBeLessThan(140);
    expect(f?.evidence).toContain("a\\u{202E}b");
  });

  it("no groups, no findings", () => {
    expect(dupeFindings([])).toEqual([]);
  });
});

describe("the dupe checks", () => {
  it("have two ids and run only when the groups are in the input", async () => {
    expect(QUERY_DUPE_CHECKS.map((c) => c.id)).toEqual(["query-dupe-slug", "query-dupe-title"]);
    expect(QUERY_DUPE_CHECKS.map((c) => c.severity)).toEqual(["high", "medium"]);
    const registry = createDupesRegistry();
    const groups: DupeGroup[] = [
      { type: "resource", key: "title", value: "MIPS guide", ids: ["res-3", "res-4"] },
    ];
    const r = await runChecks({ shapes: [], counts: new Map(), dupes: groups }, registry);
    expect(r.findings.map((f) => f.checkId)).toEqual(["query-dupe-title"]);
    expect(r.passed).toEqual(["query-dupe-slug"]);
  });
});

const shapeOf = (type: string, line: number): QueryShape => {
  const source = { file: "src/q.ts", line };
  return {
    type,
    fields: [{ path: "title", deref: false, source }],
    excludesDrafts: true,
    params: [],
    source,
  };
};

const NOW = new Date("2026-11-10T12:00:00Z");

function sanityWith(documents: Record<string, Doc[]>, extra: Partial<FakeSanity> = {}): FakeSanity {
  return {
    types: { resource: { total: RESOURCES.length } },
    documents,
    ...extra,
  };
}

describe("compareQueries with dupes: integration on recorded Sanity responses", () => {
  function run(spec: FakeSanity, seen: SeenSanityRequest[], dupes = true) {
    return compareQueries({
      shapes: [shapeOf("resource", 3)],
      env: { SANITY_PROJECT_ID: "cprhl1b4", SANITY_DATASET: "production", SANITY_TOKEN: TOKEN },
      fetcher: createFetcher({ transport: sanityCountsTransport(spec, seen), timeoutMs: 5000 }),
      now: NOW,
      dupes,
    });
  }

  it("the docs example: one high finding naming res-1 and res-2, one warning naming res-3 and res-4", async () => {
    const seen: SeenSanityRequest[] = [];
    const r = await run(sanityWith({ resource: RESOURCES }, { token: TOKEN }), seen);
    const dupes = r.result.findings.filter((f) => f.checkId.startsWith("query-dupe-"));
    expect(dupes.map((f) => [f.checkId, f.severity, f.title, f.evidence])).toEqual([
      [
        "query-dupe-slug",
        "high",
        "2 resource documents share the slug \u201Cclaim-denials\u201D",
        "Only one can own the address. res-1, res-2",
      ],
      [
        "query-dupe-title",
        "medium",
        "2 resource documents are called \u201CMIPS guide\u201D",
        "Different addresses, same thing. res-3, res-4",
      ],
    ]);
    expect(r.result.passed).not.toContain("query-dupe-slug");
    expect(() => resultSchema.parse(r.result)).not.toThrow();
  });

  it("makes one more GET for each type, all for published documents, and it is the same kind of GET", async () => {
    const seen: SeenSanityRequest[] = [];
    await run(sanityWith({ resource: RESOURCES }, { token: TOKEN }), seen);
    // One counts request and one documents request for the one type.
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.method).toBe("GET");
      expect(new URL(s.url).host).toBe("cprhl1b4.api.sanity.io");
      expect(s.url).toContain("perspective=published");
    }
  });

  it("without dupes it asks for no ids, slugs or titles and reports no duplicate", async () => {
    const seen: SeenSanityRequest[] = [];
    const r = await run(sanityWith({ resource: RESOURCES }), seen, false);
    expect(seen).toHaveLength(1);
    expect(seen.map((s) => s.query).join("")).not.toContain("slug");
    expect(r.result.findings.filter((f) => f.checkId.startsWith("query-dupe-"))).toEqual([]);
    expect([...r.result.passed, ...r.result.failed]).not.toContain("query-dupe-slug");
  });
});

describe("the promise: what is asked and what is shown", () => {
  it("the request projects exactly _id, slug.current and title, and nothing else", () => {
    const query = dupesQuery("resource");
    expect(query).toBe('*[_type == "resource"]{_id,"slug":slug.current,title}');
    const tree = parse(query) as unknown as {
      expr: { expr: { attributes: { name: string; value: unknown }[] } };
    };
    expect(tree.expr.expr.attributes.map((a) => a.name)).toEqual(["_id", "slug", "title"]);
  });

  it("run by groq-js over invented documents it returns three keys for each and no other field", async () => {
    const dataset = [
      {
        _id: "res-1",
        _type: "resource",
        slug: { current: "claim-denials" },
        title: "Claim denials",
        body: "an editor's text, never asked for",
        apiKey: "not for us",
      },
      { _id: "post-1", _type: "post", title: "Another type" },
    ];
    const result = await (await evaluate(parse(dupesQuery("resource")), { dataset })).get();
    expect(result).toEqual([{ _id: "res-1", slug: "claim-denials", title: "Claim denials" }]);
  });

  it("the token goes in a header, never in the address, and is in no output", async () => {
    const seen: SeenSanityRequest[] = [];
    const env = {
      SANITY_PROJECT_ID: "cprhl1b4",
      SANITY_DATASET: "production",
      SANITY_TOKEN: TOKEN,
    };
    const read = createSanityRead(
      env,
      createFetcher({
        transport: sanityCountsTransport(
          sanityWith({ resource: RESOURCES }, { token: TOKEN }),
          seen,
        ),
        timeoutMs: 5000,
      }),
    );
    const groups = await findDupes(["resource"], read);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).not.toContain(TOKEN);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify([groups, dupeFindings(groups)])).not.toContain(TOKEN);
  });

  it("a type name cannot add anything to the query", () => {
    const query = dupesQuery('x"] | order(secret) //');
    expect(query).toContain(JSON.stringify('x"] | order(secret) //'));
    expect(() => parse(query)).not.toThrow();
  });
});
