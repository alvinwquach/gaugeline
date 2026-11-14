import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  sanityCountsTransport,
  startGraphqlServer,
  type FakeSanity,
  type SeenSanityRequest,
} from "../../../../testkit/src/index.js";
import { ConfigError } from "../../errors.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { createQueryRegistry } from "../../checks/query-counts.js";
import {
  INTROSPECTION_QUERY,
  checkGraphql,
  defaultGraphqlEndpoint,
  displayEndpoint,
  extractGraphql,
  graphqlShapes,
  graphqlToken,
  introspect,
  parseSanityEndpoint,
  readGraphqlSchemaFile,
  sanityGraphqlEndpoint,
  schemaFromIntrospection,
  schemaFromSdl,
  schemaFromText,
  type GqlFieldUse,
} from "../graphql.js";
import { GqlSyntaxError, parseGraphql } from "../graphql-parse.js";
import { compareGraphql } from "../run.js";

const repo = fileURLToPath(new URL("../../../../fixtures/repo-gql/", import.meta.url));
const sdl = readFileSync(join(repo, "schema.graphql"), "utf8");
const recorded: unknown = JSON.parse(readFileSync(join(repo, "sanity-introspection.json"), "utf8"));

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const TOKEN = ["sk", "viewer", "Northfield0123456789abcdef"].join("_");

// An address with a password in it, put together at run time: the community check refuses what looks like an email.
const AT = String.fromCharCode(64);

const tmp: string[] = [];
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-gql-"));
  tmp.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const SMALL = schemaFromSdl(`
  schema { query: RootQuery }
  interface Document { _id: ID }
  type Resource implements Document { _id: ID title: String coach: Coach sections: [Section] }
  type Coach implements Document { _id: ID name: String }
  type Section { heading: String }
  type RootQuery { allResource: [Resource!]! Resource(id: ID!): Resource allDocument: [Document!]! }
`);

/** A schema with a name given as a Map of type to fields, for the tests that only need membership. */
function use(over: Partial<GqlFieldUse> & { field: string }): GqlFieldUse {
  return {
    parent: "",
    path: over.field,
    source: { file: "a.graphql", line: 1 },
    chain: [],
    leaf: true,
    root: { file: "a.graphql", line: 1 },
    ...over,
  };
}

describe("the GraphQL reader", () => {
  it("reads operations, fields with their lines, spreads, inline fragments and fragments", () => {
    const defs = parseGraphql(
      [
        "# a comment, and commas, are ignored",
        "query Q($id: ID! = 3, $tags: [String!]) @cached(ttl: 5) {",
        '  alias: allResource(where: { title: { eq: "}" } }, limit: 2) @include(if: $x) {',
        "    title",
        "    ...F",
        "    ... on Resource { summary }",
        "    ... @skip(if: false) { level }",
        "  }",
        "}",
        "fragment F on Resource { slug { current } }",
        "{ allEvent { title } }",
      ].join("\n"),
    );
    expect(defs.map((d) => d.kind)).toEqual(["operation", "fragment", "operation"]);
    const q = defs[0];
    if (q?.kind !== "operation") throw new Error("not an operation");
    expect(q).toMatchObject({ operation: "query", name: "Q", line: 2 });
    const root = q.selections[0];
    if (root?.kind !== "field") throw new Error("not a field");
    // The field is what the schema calls it; the alias is kept for the code that reads the result.
    expect(root).toMatchObject({ name: "allResource", alias: "alias", line: 3 });
    expect(root.selections?.[0]).not.toHaveProperty("alias");
    expect(root.selections?.map((s) => s.kind)).toEqual(["field", "spread", "inline", "inline"]);
    expect(defs[1]).toMatchObject({
      kind: "fragment",
      name: "F",
      typeCondition: "Resource",
      line: 10,
    });
  });

  it("reads strings, block strings and numbers without losing the line", () => {
    const defs = parseGraphql(
      [
        'query { a(x: """ten',
        'lines "quoted" \\""" still"""\n, y: -1.5e3) { b } }',
        "mutation { c }",
      ].join("\n"),
    );
    expect(defs).toHaveLength(2);
    expect(defs[1]).toMatchObject({ operation: "mutation", line: 4 });
  });

  it("starts counting at the line it is given", () => {
    const defs = parseGraphql("\nquery { a { b } }", 10);
    expect(defs[0]).toMatchObject({ line: 11 });
  });

  it("reads a schema: the schema block, implements both ways, extend, unions, and past enums and inputs", () => {
    const defs = parseGraphql(`
      "A description"
      schema { query: RootQuery mutation: RootMutation }
      directive @cached(ttl: Int) repeatable on FIELD | QUERY
      scalar Date
      enum Level { EASY @deprecated(reason: "x") HARD }
      input Filter { title: String = "{" }
      interface Node implements Base & Other { id: ID }
      type A implements Node & Other @key(fields: "id") { id: ID """d""" b(x: Int = 1): [B!]! }
      type B implements Node, Other { id: ID }
      extend type A { c: String }
      union U = | A | B
    `);
    const types = defs.filter((d) => d.kind === "type");
    expect(types.map((t) => [t.kind === "type" && t.flavor, t.kind === "type" && t.name])).toEqual([
      ["interface", "Node"],
      ["object", "A"],
      ["object", "B"],
      ["object", "A"],
      ["union", "U"],
    ]);
  });

  it("says where it gave up", () => {
    const tries = [
      "query {",
      "query { a(x: ) }\n}",
      '{ a(x: "open) }',
      "{ a } }",
      "type X { a }",
      "{ a . b }",
    ];
    for (const text of tries) expect(() => parseGraphql(text)).toThrow(GqlSyntaxError);
    try {
      parseGraphql("query {\n  a {\n  }\n}");
    } catch (err) {
      expect((err as GqlSyntaxError).line).toBe(3);
    }
  });
});

describe("extractGraphql", () => {
  it("reads a .graphql file, a gql tag and a query that uses a fragment from another file", async () => {
    const dir = tree({
      "gql/resources.graphql": "query Resources { allResource { title author } }\n",
      "src/frag.ts":
        'import { gql } from "x";\nexport const COACH = gql`\n  fragment CoachBits on Coach {\n    name\n  }\n`;\n',
      "src/page.tsx":
        'import { gql } from "x";\nconst Q = gql`\n  query Page {\n    allResource {\n      title\n      coach { ...CoachBits }\n    }\n  }\n`;\n',
    });
    const r = await extractGraphql(dir);
    expect(r.unreadable).toEqual([]);
    expect(r).toMatchObject({ queries: 2, fragments: 1, files: 3 });
    const by = (path: string) => r.uses.filter((u) => u.path === path);
    // The file:line of a field is the line it is written on, in a template too.
    expect(by("allResource.author")[0]).toMatchObject({
      parent: "",
      field: "author",
      source: { file: "gql/resources.graphql", line: 1 },
      leaf: true,
    });
    expect(by("allResource.title").map((u) => u.source)).toEqual([
      { file: "gql/resources.graphql", line: 1 },
      { file: "src/page.tsx", line: 3 },
    ]);
    // The fragment's field is found at the fragment, with the type the fragment names, under the path it was spread at.
    expect(by("allResource.coach.name")[0]).toMatchObject({
      parent: "Coach",
      source: { file: "src/frag.ts", line: 3 },
      chain: [
        { field: "allResource", on: "" },
        { field: "coach", on: "" },
      ],
    });
  });

  it("resolves a fragment interpolated into a template, and lists one built from a string", async () => {
    const dir = tree({
      "a.ts":
        'import { gql } from "x";\nexport const F = gql`fragment F on Resource { level }`;\nexport const Q = gql`\n  query { allResource { ...F } }\n  ${F}\n`;\n',
      "b.ts":
        'import { gql } from "x";\nconst name = "title";\nexport const Q = gql`query { allResource { ${name} } }`;\n',
      "c.ts":
        'import { gql } from "x";\nexport const Q = gql`query { allResource { ${"title"} } }`;\n',
      "d.ts":
        'import { gql } from "x";\nexport const Q = gql`query { allResource { ...Gone } }`;\n',
    });
    const r = await extractGraphql(dir);
    expect(r.uses.map((u) => u.path)).toContain("allResource.level");
    expect(r.unreadable).toEqual([
      { reason: "concatenated", source: { file: "b.ts", line: 3 } },
      { reason: "concatenated", source: { file: "c.ts", line: 2 } },
      { reason: "unknown-fragment", source: { file: "d.ts", line: 2 } },
    ]);
  });

  it("keeps the line numbers of a template with an interpolation on several lines", async () => {
    const dir = tree({
      "a.ts":
        "import { gql } from 'x';\nconst F = gql`fragment F on Resource { level }`;\nexport const Q = gql`\n  ${\n    F\n  }\n  query { allResource { title } }\n`;\n",
    });
    const r = await extractGraphql(dir);
    expect(r.uses.find((u) => u.field === "title")?.source).toEqual({ file: "a.ts", line: 7 });
  });

  it("counts mutations and subscriptions and walks none of their fields", async () => {
    const dir = tree({
      "m.graphql":
        "mutation A { enrol(x: 1) { id } }\nmutation B { cancel { id } }\nsubscription S { seats }\nquery Q { allResource { title } }\n",
      "t.ts": 'import { gql } from "x";\nexport const M = gql`mutation C { pay { id } }`;\n',
    });
    const r = await extractGraphql(dir);
    expect(r.mutations).toEqual([
      { file: "m.graphql", line: 1 },
      { file: "m.graphql", line: 2 },
      { file: "t.ts", line: 2 },
    ]);
    expect(r.subscriptions).toEqual([{ file: "m.graphql", line: 3 }]);
    expect(r.uses.map((u) => u.path)).toEqual(["allResource", "allResource.title"]);
  });

  it("checks a fragment no query reaches on the type it names", async () => {
    const dir = tree({
      "f.graphql": "fragment Lonely on Resource {\n  title\n  coach { name }\n}\n",
    });
    const r = await extractGraphql(dir);
    expect(r.uses.map((u) => [u.path, u.parent, u.source.line])).toEqual([
      ["...Lonely.title", "Resource", 1],
      ["...Lonely.coach", "Resource", 1],
      ["...Lonely.coach.name", "", 1],
    ]);
  });

  it("reads a fragment that spreads itself, or the same fragment twice, once", async () => {
    const dir = tree({
      "f.graphql":
        "query { allResource { ...A ...A } }\nfragment A on Resource { title ...B }\nfragment B on Resource { level ...A }\n",
    });
    const r = await extractGraphql(dir);
    expect(r.uses.filter((u) => u.field === "title")).toHaveLength(1);
  });

  it("lists a document that does not parse, with the line, and a TypeScript file that does not", async () => {
    const dir = tree({
      "bad.graphql": "query {\n  allResource {\n    title\n",
      "bad.ts": 'import { gql } from "x";\nconst a = ;\n',
      "tag.ts":
        'import { gql } from "x";\nexport const Q = gql`\n  query {\n    allResource { title\n  }\n`;\n',
      "node_modules/x/a.graphql": "query { nope }",
      "plain.ts": "export const x = 1;\n",
    });
    const r = await extractGraphql(dir);
    expect(r.unreadable.map((u) => `${u.reason} ${u.source.file}:${u.source.line}`).sort()).toEqual(
      ["parse-error bad.graphql:4", "parse-error bad.ts:2", "parse-error tag.ts:6"],
    );
    expect(r.uses).toEqual([]);
  });

  it("reads the invented repository: what it holds, and what it could not read", async () => {
    const r = await extractGraphql(repo);
    expect(r).toMatchObject({ queries: 3, fragments: 1, files: 5 });
    expect(r.mutations).toEqual([{ file: "gql/enrol.graphql", line: 2 }]);
    expect(r.subscriptions).toEqual([{ file: "gql/enrol.graphql", line: 8 }]);
    expect(r.unreadable).toEqual([
      { reason: "concatenated", source: { file: "src/lib/dynamic.ts", line: 5 } },
    ]);
  });

  it("says how to bring TypeScript when it is missing", async () => {
    await expect(
      extractGraphql(repo, {
        loadTypeScript: () => Promise.reject(new Error("Cannot find package 'typescript'")),
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("the schema", () => {
  it("is the same from SDL and from the recorded introspection answer", () => {
    const a = schemaFromSdl(sdl);
    const b = schemaFromIntrospection(recorded);
    expect(b.queryType).toBe("RootQuery");
    expect(a.queryType).toBe("RootQuery");
    expect([...b.fields.keys()].sort()).toEqual([...a.fields.keys()].sort());
    for (const [type, fields] of a.fields)
      expect([...(b.fields.get(type) ?? [])].sort()).toEqual([...fields].sort());
    expect(b.returns.get("RootQuery")?.get("allResource")).toEqual({
      type: "Resource",
      list: true,
    });
    expect(b.returns.get("Resource")?.get("coach")).toEqual({ type: "Coach", list: false });
    expect([...(b.possible.get("Document") ?? [])].sort()).toEqual(["Coach", "Event", "Resource"]);
    expect([...(a.possible.get("Document") ?? [])].sort()).toEqual(["Coach", "Event", "Resource"]);
    expect(b.implementsOf.get("Resource")).toEqual(new Set(["Document"]));
  });

  it("reads an introspection answer with or without the data wrapper, and refuses anything else", () => {
    const inner = (recorded as { data: unknown }).data;
    expect(schemaFromIntrospection(inner).fields.has("Resource")).toBe(true);
    expect(() => schemaFromIntrospection({ errors: [] })).toThrow();
    expect(() => schemaFromIntrospection("x")).toThrow();
  });

  it("reads a --schema file as SDL or as introspection JSON and says which it could not read", () => {
    expect(schemaFromText(sdl, "s.graphql").fields.has("Coach")).toBe(true);
    expect(schemaFromText(JSON.stringify(recorded), "s.json").fields.has("Coach")).toBe(true);
    expect(() => schemaFromText('{"a": 1}', "s.json")).toThrow(
      /not the answer to an introspection query/,
    );
    expect(() => schemaFromText("type {", "s.graphql")).toThrow(/not a GraphQL schema/);
  });

  it("names a file that is not there", async () => {
    await expect(readGraphqlSchemaFile(join(repo, "nope.graphql"))).rejects.toBeInstanceOf(
      ConfigError,
    );
    expect((await readGraphqlSchemaFile(join(repo, "schema.graphql"))).fields.has("Event")).toBe(
      true,
    );
  });

  it("keeps deprecated fields, so a field the server still answers is never reported", () => {
    expect(INTROSPECTION_QUERY).toContain("includeDeprecated:true");
  });
});

describe("checkGraphql", () => {
  const schema = schemaFromSdl(sdl);

  it("reports a field missing from the type once, with the path and the file and line", async () => {
    const r = await extractGraphql(repo);
    const findings = checkGraphql(r.uses, schema);
    expect(findings.map((f) => [f.checkId, f.severity, f.title, f.evidence])).toEqual([
      [
        "graphql-field-not-in-schema",
        "high",
        "author isn't in the schema",
        "allResource.author \u00B7 gql/resources.graphql:1",
      ],
      [
        "graphql-field-not-in-schema",
        "high",
        "nickname isn't in the schema",
        "Resource.coach.nickname \u00B7 src/lib/fragments.ts:4",
      ],
    ]);
    expect(findings[0]?.source).toEqual({ file: "gql/resources.graphql", line: 1 });
  });

  it("finds a field on an interface through its implementations", () => {
    // `title` is on Resource, not on Document: allDocument can be a Resource, so it is there.
    const ok = checkGraphql(
      [
        use({ field: "allDocument", leaf: false, path: "allDocument" }),
        use({
          field: "title",
          parent: "",
          path: "allDocument.title",
          chain: [{ field: "allDocument", on: "" }],
        }),
        use({ field: "_id", path: "allDocument._id", chain: [{ field: "allDocument", on: "" }] }),
      ],
      SMALL,
    );
    expect(ok).toEqual([]);
    const bad = checkGraphql(
      [use({ field: "nope", path: "allDocument.nope", chain: [{ field: "allDocument", on: "" }] })],
      SMALL,
    );
    expect(bad).toHaveLength(1);
  });

  it("reads the type from a type condition, and from a fragment's own type", () => {
    const findings = checkGraphql(
      [
        use({ field: "allDocument", leaf: false, path: "allDocument" }),
        use({
          field: "bio",
          parent: "Coach",
          path: "allDocument.bio",
          chain: [{ field: "allDocument", on: "" }],
          source: { file: "a.graphql", line: 4 },
        }),
        use({
          field: "name",
          parent: "Coach",
          path: "allDocument.name",
          chain: [{ field: "allDocument", on: "" }],
        }),
      ],
      SMALL,
    );
    expect(findings.map((f) => f.evidence)).toEqual(["allDocument.bio \u00B7 a.graphql:4"]);
  });

  it("does not report what is below a missing field again, or what it cannot place", () => {
    const findings = checkGraphql(
      [
        use({ field: "gone", leaf: false, path: "gone" }),
        use({ field: "x", path: "gone.x", chain: [{ field: "gone", on: "" }] }),
        // A type the schema does not have: nothing to compare with.
        use({ field: "y", parent: "Mystery", path: "y" }),
        use({
          field: "z",
          path: "allResource.z",
          chain: [{ field: "allResource", on: "Mystery" }],
        }),
      ],
      SMALL,
    );
    expect(findings.map((f) => f.evidence)).toEqual(["gone \u00B7 a.graphql:1"]);
  });

  it("reports a fragment read at two places once, where it is written", () => {
    const at = { file: "f.graphql", line: 2 };
    const findings = checkGraphql(
      [
        use({ field: "allResource", leaf: false, path: "allResource" }),
        use({
          field: "ghost",
          parent: "Resource",
          path: "allResource.ghost",
          source: at,
          chain: [{ field: "allResource", on: "" }],
        }),
        use({
          field: "ghost",
          parent: "Resource",
          path: "Resource.ghost",
          source: at,
          chain: [{ field: "Resource", on: "" }],
        }),
      ],
      SMALL,
    );
    expect(findings).toHaveLength(1);
  });

  it("shows invisible characters in a field name as escapes", () => {
    const findings = checkGraphql(
      [
        use({
          field: "a\u200Bb",
          path: "allResource.a\u200Bb",
          chain: [{ field: "allResource", on: "" }],
        }),
      ],
      SMALL,
    );
    expect(findings[0]?.evidence).toContain("\\u{200B}");
    expect(findings[0]?.title).toContain("\\u{200B}");
  });

  it("asks one Map lookup for each field use", () => {
    expect(SMALL.fields).toBeInstanceOf(Map);
    expect(SMALL.fields.get("Resource")).toBeInstanceOf(Set);
  });
});

describe("the endpoint", () => {
  it("is Sanity's, built from the project id and the dataset", () => {
    expect(sanityGraphqlEndpoint("northfield", "production")).toBe(
      "https://northfield.api.sanity.io/v1/graphql/production/default",
    );
    expect(sanityGraphqlEndpoint("northfield", "my data", "staging")).toBe(
      "https://northfield.api.sanity.io/v1/graphql/my%20data/staging",
    );
    expect(
      defaultGraphqlEndpoint({ SANITY_PROJECT_ID: "northfield", SANITY_DATASET: "staging" }),
    ).toEqual({
      endpoint: "https://northfield.api.sanity.io/v1/graphql/staging/default",
      datasetAssumed: false,
    });
    expect(defaultGraphqlEndpoint({ SANITY_PROJECT_ID: "northfield" })).toEqual({
      endpoint: "https://northfield.api.sanity.io/v1/graphql/production/default",
      datasetAssumed: true,
    });
  });

  it("needs a project id, and says what to do without one", () => {
    expect(() => defaultGraphqlEndpoint({})).toThrow(ConfigError);
    expect(() => defaultGraphqlEndpoint({ SANITY_PROJECT_ID: "Not A Project" })).toThrow(
      /Sanity project id/,
    );
  });

  it("names the project and dataset of a Sanity address, and nothing for another", () => {
    expect(
      parseSanityEndpoint("https://northfield.api.sanity.io/v1/graphql/staging/default"),
    ).toEqual({
      projectId: "northfield",
      dataset: "staging",
    });
    expect(parseSanityEndpoint("https://example.com/graphql")).toBeNull();
    expect(
      parseSanityEndpoint("https://northfield.api.sanity.io.evil.example/v1/graphql/a/b"),
    ).toBeNull();
    expect(parseSanityEndpoint("https://northfield.api.sanity.io/v1/data/query/a")).toBeNull();
  });

  it("sends SANITY_TOKEN to Sanity's own address only, and GRAPHQL_TOKEN anywhere else", () => {
    const env = { SANITY_TOKEN: "sanity-secret-aaa", GRAPHQL_TOKEN: "other-secret-bbb" };
    expect(
      graphqlToken("https://northfield.api.sanity.io/v1/graphql/production/default", env),
    ).toEqual({
      name: "SANITY_TOKEN",
      value: "sanity-secret-aaa",
    });
    expect(graphqlToken("https://example.com/graphql", env)).toEqual({
      name: "GRAPHQL_TOKEN",
      value: "other-secret-bbb",
    });
    expect(
      graphqlToken("https://example.com/graphql", { SANITY_TOKEN: "sanity-secret-aaa" }).value,
    ).toBeUndefined();
  });

  it("is printed without a user name, a password or a query string", () => {
    expect(displayEndpoint(`https://me:pw${AT}example.com/graphql?key=abc`)).toBe(
      "https://example.com/graphql?\u2026",
    );
    expect(displayEndpoint("https://example.com/graphql")).toBe("https://example.com/graphql");
  });
});

/** A transport that answers like a GraphQL endpoint and keeps what it was asked. */
function endpointTransport(
  answer: (url: URL) => { status: number; body: unknown; headers?: Record<string, string> },
  seen: Array<{ method: string; url: URL; headers: Record<string, string> }> = [],
): Transport {
  return (url, req) => {
    seen.push({ method: req.method, url, headers: req.headers });
    const a = answer(url);
    return Promise.resolve({
      status: a.status,
      headers: { "content-type": "application/json", ...a.headers },
      body: Readable.from([
        Buffer.from(typeof a.body === "string" ? a.body : JSON.stringify(a.body)),
      ]),
    });
  };
}

describe("introspect", () => {
  it("sends the introspection query as a GET with the query in the address, and the token in a header", async () => {
    const seen: Array<{ method: string; url: URL; headers: Record<string, string> }> = [];
    const fetcher = createFetcher({
      transport: endpointTransport(() => ({ status: 200, body: recorded }), seen),
    });
    const schema = await introspect("https://example.com/graphql?tenant=a", TOKEN, fetcher);
    expect(schema.fields.get("Resource")?.has("title")).toBe(true);
    expect(seen).toHaveLength(1);
    const first = seen[0];
    expect(first?.method).toBe("GET");
    expect(first?.url.searchParams.get("query")).toBe(INTROSPECTION_QUERY);
    // What was in the address stays, and the token is in a header only.
    expect(first?.url.searchParams.get("tenant")).toBe("a");
    expect(first?.url.href).not.toContain(TOKEN);
    expect(first?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sends no Authorization header when there is no token", async () => {
    const seen: Array<{ method: string; url: URL; headers: Record<string, string> }> = [];
    const fetcher = createFetcher({
      transport: endpointTransport(() => ({ status: 200, body: recorded }), seen),
    });
    await introspect("https://example.com/graphql", undefined, fetcher);
    expect(Object.keys(seen[0]?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain(
      "authorization",
    );
  });

  it("does not put a document's text, or the word mutation, in the request", () => {
    expect(INTROSPECTION_QUERY.toLowerCase()).not.toContain("mutation");
    expect(INTROSPECTION_QUERY.toLowerCase()).not.toContain("subscription");
  });

  it("answers an endpoint that will not take a GET with the --schema hint, and asks nothing else", async () => {
    for (const status of [405, 400, 404, 501]) {
      const seen: Array<{ method: string; url: URL; headers: Record<string, string> }> = [];
      const fetcher = createFetcher({
        transport: endpointTransport(
          () => ({ status, body: "no", headers: { allow: "POST" } }),
          seen,
        ),
      });
      const err = await introspect("https://example.com/graphql", undefined, fetcher).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain(`HTTP ${status}`);
      expect(`${(err as ConfigError).message} ${(err as ConfigError).hint}`).toContain("--schema");
      expect(seen.map((s) => s.method)).toEqual(["GET"]);
    }
  });

  it("says introspection is turned off when the answer has no schema, and points to --schema", async () => {
    const fetcher = createFetcher({
      transport: endpointTransport(() => ({
        status: 200,
        body: { errors: [{ message: "introspection is disabled" }] },
      })),
    });
    const err = await introspect("https://example.com/graphql", undefined, fetcher).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect(`${(err as ConfigError).message} ${(err as ConfigError).hint}`).toMatch(
      /introspection is probably turned off[\s\S]*--schema/,
    );
    // What the server said is not repeated.
    expect((err as ConfigError).message).not.toContain("disabled");
  });

  it("says when the endpoint refuses, names the right variable, and never prints the token", async () => {
    const fetcher = createFetcher({
      transport: endpointTransport(() => ({ status: 401, body: "{}" })),
    });
    const open = await introspect("https://example.com/graphql", undefined, fetcher).catch(
      (e: unknown) => e,
    );
    expect((open as ConfigError).hint).toContain("GRAPHQL_TOKEN");
    const sanity = await introspect(
      "https://northfield.api.sanity.io/v1/graphql/production/default",
      undefined,
      fetcher,
    ).catch((e: unknown) => e);
    expect((sanity as ConfigError).hint).toContain("SANITY_TOKEN");
    const withToken = await introspect("https://example.com/graphql", TOKEN, fetcher).catch(
      (e: unknown) => e,
    );
    expect(
      JSON.stringify([(withToken as ConfigError).message, (withToken as ConfigError).hint]),
    ).not.toContain(TOKEN);
  });

  it("refuses an answer that is not JSON, an address with a password, and a token over plain http", async () => {
    const fetcher = createFetcher({
      transport: endpointTransport(() => ({ status: 200, body: "<html>" })),
    });
    await expect(introspect("https://example.com/graphql", undefined, fetcher)).rejects.toThrow(
      /not JSON/,
    );
    await expect(
      introspect(`https://u:p${AT}example.com/graphql`, undefined, fetcher),
    ).rejects.toThrow(/user name or password/);
    await expect(introspect("http://example.com/graphql", TOKEN, fetcher)).rejects.toThrow(
      /not https/,
    );
    await expect(introspect("ftp://example.com/graphql", undefined, fetcher)).rejects.toThrow(
      /http or https/,
    );
    await expect(introspect("not an address", undefined, fetcher)).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("refuses an address on this computer unless the fetcher allows it", async () => {
    const server = await startGraphqlServer({ introspection: recorded });
    try {
      await expect(introspect(server.url, undefined, createFetcher())).rejects.toBeInstanceOf(
        Error,
      );
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe("the content count step", () => {
  const schema = schemaFromSdl(sdl);

  it("maps each queried document type to its Sanity type, with the paths the count reads", async () => {
    const r = await extractGraphql(repo);
    const shapes = graphqlShapes(r.uses, schema);
    expect(
      shapes.map((s) => [s.type, `${s.source.file}:${s.source.line}`, s.fields.map((f) => f.path)]),
    ).toEqual([
      ["resource", "gql/resources.graphql:1", ["_id", "title"]],
      ["event", "src/app/events/page.tsx:4", ["_id", "title", "startsAt", "venue"]],
      ["resource", "src/lib/queries.ts:5", ["title", "summary", "slug.current", "coach->name"]],
    ]);
    expect(shapes.every((s) => s.excludesDrafts)).toBe(true);
    // A reference reads as `->`, and a field the schema does not have was reported, not counted.
    expect(shapes.flatMap((s) => s.fields.map((f) => f.path))).not.toContain("author");
    expect(shapes[2]?.fields.find((f) => f.path === "coach->name")?.deref).toBe(true);
  });

  it("writes a list of objects the way the count reads it", () => {
    const s = schemaFromSdl(`
      interface Document { _id: ID }
      type Page implements Document { _id: ID sections: [Section] related: [Page] }
      type Section { heading: String items: [Item] }
      type Item { label: String }
      type Query { allPage: [Page] }
    `);
    const shapes = graphqlShapes(
      [
        use({
          field: "heading",
          path: "x",
          chain: [
            { field: "allPage", on: "" },
            { field: "sections", on: "" },
          ],
        }),
        use({
          field: "label",
          path: "x",
          chain: [
            { field: "allPage", on: "" },
            { field: "sections", on: "" },
            { field: "items", on: "" },
          ],
        }),
        use({
          field: "_id",
          path: "x",
          chain: [
            { field: "allPage", on: "" },
            { field: "related", on: "" },
          ],
        }),
      ],
      s,
    );
    expect(shapes[0]?.type).toBe("page");
    expect(shapes[0]?.fields.map((f) => f.path)).toEqual([
      "sections[].heading",
      "sections[].items[].label",
      "related[]->_id",
    ]);
  });

  it("does not make a shape of a type that is not a Sanity document", () => {
    const s = schemaFromSdl("type Thing { a: String } type Query { things: [Thing] }");
    expect(graphqlShapes([use({ field: "a", chain: [{ field: "things", on: "" }] })], s)).toEqual(
      [],
    );
  });

  async function compare(types: FakeSanity["types"], seen: SeenSanityRequest[] = []) {
    const r = await extractGraphql(repo);
    return compareGraphql({
      uses: r.uses,
      schema,
      sanity: {
        env: { SANITY_PROJECT_ID: "northfield", SANITY_DATASET: "production" },
        fetcher: createFetcher({
          transport: sanityCountsTransport({ types }, seen),
          timeoutMs: 5000,
        }),
      },
      now: new Date("2026-11-10T12:00:00Z"),
    });
  }

  it("reports a field that is in the schema and on no document from the counts, not from the schema", async () => {
    const seen: SeenSanityRequest[] = [];
    const run = await compare(
      { resource: { total: 9, defined: { summary: 0, coach: 5 } }, event: { total: 4 } },
      seen,
    );
    const byId = (id: string) => run.result.findings.filter((f) => f.checkId === id);
    expect(byId("graphql-field-not-in-schema").map((f) => f.title)).toEqual([
      "author isn't in the schema",
      "nickname isn't in the schema",
    ]);
    expect(byId("query-field-absent").map((f) => f.evidence)).toEqual([
      "src/lib/queries.ts:5  summary doesn't exist on any resource: 0 of 9 documents have it. The field was probably renamed, so what shows it renders empty.",
    ]);
    // `summary` is in the schema, so introspection alone could not have said so.
    expect(
      checkGraphql((await extractGraphql(repo)).uses, schema).map((f) => f.title),
    ).not.toContain("summary isn't in the schema");
    expect(byId("query-field-partial").map((f) => f.evidence)).toEqual([
      "src/lib/queries.ts:5  coach is missing on 4 of 9 documents. Fine if it is optional; a bug if the template assumes it.",
    ]);
    // No drafts finding: the GraphQL API serves published documents.
    expect(byId("query-no-drafts-filter")).toEqual([]);
    expect(run.types).toBe(2);
    // One GET for each type, counts only.
    expect(seen.map((s) => [s.method, s.type]).sort()).toEqual([
      ["GET", "event"],
      ["GET", "resource"],
    ]);
  });

  it("reports a type with no documents once", async () => {
    const run = await compare({ resource: { total: 0 }, event: { total: 3 } });
    expect(run.result.findings.filter((f) => f.checkId === "query-type-empty")).toHaveLength(2);
    expect(run.result.findings.filter((f) => f.checkId === "query-field-absent")).toEqual([]);
  });

  it("makes no request and runs no count check without a dataset to ask", async () => {
    const r = await extractGraphql(repo);
    const run = await compareGraphql({
      uses: r.uses,
      schema,
      now: new Date("2026-11-10T12:00:00Z"),
    });
    expect(run.types).toBe(0);
    expect(run.result.findings.map((f) => f.checkId)).toEqual([
      "graphql-field-not-in-schema",
      "graphql-field-not-in-schema",
    ]);
    // A check that did not run is not shown as passed.
    expect(run.result.passed).toEqual([]);
  });

  it("registers the GraphQL check only when asked", () => {
    expect(
      createQueryRegistry()
        .all()
        .map((c) => c.id),
    ).not.toContain("graphql-field-not-in-schema");
    expect(
      createQueryRegistry({ graphql: true })
        .all()
        .map((c) => c.id),
    ).toContain("graphql-field-not-in-schema");
  });
});

describe("a local endpoint: the promise", () => {
  const MUTATIONS = {
    "a.graphql": "mutation One { enrol { id } }\nquery Q { allResource { title } }\n",
    "b.ts":
      'import { gql } from "x";\nexport const M = gql`\n  mutation Two { pay { id } }\n  subscription Three { seats }\n`;\n',
    "c.graphql": "mutation Three($x: ID!) { cancel(x: $x) { id } }\n",
  };

  it("asks with a GET and no body, whatever the repository holds, and the word mutation is in no request", async () => {
    const server = await startGraphqlServer({ introspection: recorded, token: TOKEN });
    try {
      const dir = tree(MUTATIONS);
      const found = await extractGraphql(dir);
      expect(found.mutations).toHaveLength(3);
      const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 5000 });
      const schema = await introspect(server.url, TOKEN, fetcher);
      const run = await compareGraphql({ uses: found.uses, schema, now: new Date() });
      expect(run.result.findings).toEqual([]);
      expect(server.requests.length).toBeGreaterThan(0);
      for (const r of server.requests) {
        expect(r.method).toBe("GET");
        expect(r.body).toBe("");
        expect(`${r.url} ${JSON.stringify(r.headers)}`.toLowerCase()).not.toContain("mutation");
        expect(r.url).not.toContain(TOKEN);
      }
      // The token went in the header.
      expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    } finally {
      await server.close();
    }
  });

  it("answers an endpoint that takes POST only with the --schema hint, and never tries a POST", async () => {
    const server = await startGraphqlServer({ introspection: recorded, mode: "get-405" });
    try {
      const err = await introspect(
        server.url,
        undefined,
        createFetcher({ allowPrivate: true, timeoutMs: 5000 }),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("HTTP 405");
      expect((err as ConfigError).hint).toContain("--schema");
      expect(server.requests.map((r) => r.method)).toEqual(["GET"]);
    } finally {
      await server.close();
    }
  });

  it("answers an endpoint with introspection turned off with the --schema hint", async () => {
    const server = await startGraphqlServer({ introspection: recorded, mode: "disabled" });
    try {
      const err = await introspect(
        server.url,
        undefined,
        createFetcher({ allowPrivate: true, timeoutMs: 5000 }),
      ).catch((e: unknown) => e);
      expect((err as ConfigError).hint).toContain("--schema");
      expect(server.requests.map((r) => r.method)).toEqual(["GET"]);
    } finally {
      await server.close();
    }
  });
});

describe("graphql.ts keeps its promise in the source", () => {
  it("never builds a request that is not a GET, and never puts a document in one", () => {
    const text = readFileSync(fileURLToPath(new URL("../graphql.ts", import.meta.url)), "utf8");
    // The one request is the connector's GET.
    expect(text.match(/connectorGet\(/g)).toHaveLength(1);
    for (const banned of [
      /\bfetch\(/,
      /node:http/,
      /node:https/,
      /node:net/,
      /method:\s*["']POST/i,
      /\.post\(/,
    ]) {
      expect(text).not.toMatch(banned);
    }
  });
});
