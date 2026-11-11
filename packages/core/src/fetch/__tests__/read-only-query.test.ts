import { describe, expect, it } from "vitest";
import {
  allowProblems,
  bodyProblem,
  isReadOnlyBody,
  matchesPath,
  queryRefusal,
  type ReadOnlyQueryAllow,
} from "../read-only-query.js";

const DOCS = { url: "https://dev.example/docs/query-items", checked: "2026-11-11" } as const;

const graphql: ReadOnlyQueryAllow = {
  id: "shop-graphql",
  method: "POST",
  host: "api.shop.example",
  path: "/graphql",
  body: { kind: "graphql-query" },
  docs: DOCS,
};

const json: ReadOnlyQueryAllow = {
  id: "items-query",
  method: "POST",
  host: "www.wixapis.example",
  path: "/wix-data/v2/items/query",
  body: { kind: "json-query", keys: ["dataCollectionId", "query", "returnTotalCount"] },
  docs: DOCS,
};

describe("matchesPath", () => {
  it("matches a literal path exactly and * as one whole segment", () => {
    expect(matchesPath("/graphql", "/graphql")).toBe(true);
    expect(matchesPath("/graphql", "/graphql/")).toBe(false);
    expect(matchesPath("/v1/data/query/*", "/v1/data/query/production")).toBe(true);
    expect(matchesPath("/v1/data/query/*", "/v1/data/query/")).toBe(false);
    expect(matchesPath("/v1/data/query/*", "/v1/data/query/a/b")).toBe(false);
    expect(matchesPath("/v1/*/query", "/v1/x/query")).toBe(true);
  });

  it("refuses dot segments, doubled slashes and encoded slashes", () => {
    expect(matchesPath("/v1/*/query", "/v1/../query")).toBe(false);
    expect(matchesPath("/v1/*/query", "/v1/%2e%2e/query")).toBe(false);
    expect(matchesPath("/v1/*/query", "/v1/a%2Fb/query")).toBe(false);
    expect(matchesPath("/graphql", "//graphql")).toBe(false);
  });
});

describe("graphql-query bodies", () => {
  const ok = (query: string, extra: Record<string, unknown> = {}) =>
    isReadOnlyBody(graphql, { query, ...extra });

  it("accepts a query, a named query, a shorthand query, aliases and fragments", () => {
    expect(ok("{ posts { id } }")).toBe(true);
    expect(ok("query Posts($n: Int) { posts(first: $n) { id } }", { variables: { n: 3 } })).toBe(
      true,
    );
    expect(ok("query { a: posts { id } b: posts { slug } }")).toBe(true);
    expect(ok("query { posts { ...F } } fragment F on Post { id }")).toBe(true);
  });

  it("accepts the words mutation and subscription inside strings, comments and field names", () => {
    expect(ok('query { posts(filter: "mutation") { id } }')).toBe(true);
    expect(ok("# mutation { x }\nquery { posts { id } }")).toBe(true);
    expect(ok("query { mutation_log: logs { id } subscriptionCount }")).toBe(true);
    expect(ok("query { a: mutation { id } }")).toBe(true);
  });

  it("refuses a mutation, a subscription, in any case and after comments or a query", () => {
    expect(ok("mutation { deletePost(id: 1) { id } }")).toBe(false);
    expect(ok("mutation Delete { x }")).toBe(false);
    expect(ok("subscription { posts { id } }")).toBe(false);
    expect(ok("# read only\n\n  mutation { x }")).toBe(false);
    expect(ok("query A { a } mutation B { b }")).toBe(false);
  });

  it("refuses a document with more than one operation, or with none", () => {
    expect(ok("query A { a } query B { b }")).toBe(false);
    expect(ok("fragment F on Post { id }")).toBe(false);
    expect(ok("")).toBe(false);
  });

  it("refuses text that is not GraphQL and type system definitions", () => {
    expect(ok("query { posts {")).toBe(false);
    expect(ok("type Post { id: ID }")).toBe(false);
    expect(ok("query { a } extend type Post { b: Int }")).toBe(false);
  });

  it("refuses a body that is not exactly the GraphQL request keys", () => {
    expect(ok("{ a }", { delete: true })).toBe(false);
    expect(isReadOnlyBody(graphql, [{ query: "{ a }" }])).toBe(false);
    expect(isReadOnlyBody(graphql, "{ a }")).toBe(false);
    expect(isReadOnlyBody(graphql, null)).toBe(false);
    expect(isReadOnlyBody(graphql, { query: 7 })).toBe(false);
    expect(ok("{ a }", { variables: "x" })).toBe(false);
    expect(ok("{ a }", { operationName: 3 })).toBe(false);
  });

  it("a persisted query id is refused unless the entry says persisted queries are allowed", () => {
    const body = { id: "abc123", variables: { n: 1 } };
    expect(isReadOnlyBody(graphql, body)).toBe(false);
    const persisted = { ...graphql, body: { kind: "graphql-query", persistedQueries: true } };
    expect(isReadOnlyBody(persisted as ReadOnlyQueryAllow, body)).toBe(true);
    expect(
      isReadOnlyBody(persisted as ReadOnlyQueryAllow, {
        extensions: { persistedQuery: { version: 1, sha256Hash: "ab".repeat(32) } },
      }),
    ).toBe(true);
    expect(isReadOnlyBody(persisted as ReadOnlyQueryAllow, { id: 5 })).toBe(false);
    expect(isReadOnlyBody(persisted as ReadOnlyQueryAllow, {})).toBe(false);
  });
});

describe("json-query bodies", () => {
  it("accepts a body whose keys are all on the allowlist", () => {
    expect(
      isReadOnlyBody(json, { dataCollectionId: "Menu", query: { filter: { createdDate: 1 } } }),
    ).toBe(true);
  });

  it("refuses a key that is not on the allowlist", () => {
    expect(isReadOnlyBody(json, { dataCollectionId: "Menu", extra: 1 })).toBe(false);
  });

  it("refuses a key named like a write, even if the entry lists it", () => {
    for (const key of ["insert", "dataItem", "updateItem", "$set", "delete_item", "mutation"]) {
      const bad = { ...json, body: { kind: "json-query", keys: ["query", key] } };
      const problem = bodyProblem(bad as ReadOnlyQueryAllow, { query: {}, [key]: {} });
      if (key === "dataItem") expect(problem).toBeUndefined();
      else expect(problem, key).toMatch(/write/);
    }
  });

  it("refuses an array, a string, null and a value that is not JSON", () => {
    expect(isReadOnlyBody(json, [])).toBe(false);
    expect(isReadOnlyBody(json, "x")).toBe(false);
    expect(isReadOnlyBody(json, null)).toBe(false);
    expect(isReadOnlyBody(json, { query: 10n })).toBe(false);
  });

  it("refuses a body over the size limit", () => {
    expect(isReadOnlyBody(json, { query: "x".repeat(70_000) })).toBe(false);
  });
});

describe("allowProblems", () => {
  it("accepts a well-formed entry", () => {
    expect(allowProblems(graphql)).toEqual([]);
    expect(allowProblems(json)).toEqual([]);
    expect(allowProblems({ ...json, docs: { url: DOCS.url, checked: null } })).toEqual([]);
  });

  it("refuses a method other than POST, a wildcard or odd host, and a bad path", () => {
    expect(allowProblems({ ...json, method: "PUT" } as never)).not.toEqual([]);
    expect(allowProblems({ ...json, host: "*.wixapis.example" })).not.toEqual([]);
    expect(allowProblems({ ...json, host: "https://www.wixapis.example" })).not.toEqual([]);
    expect(allowProblems({ ...json, host: "WWW.example" })).not.toEqual([]);
    expect(allowProblems({ ...json, path: "wix-data" })).not.toEqual([]);
    expect(allowProblems({ ...json, path: "/a/**" })).not.toEqual([]);
    expect(allowProblems({ ...json, path: "/a/b*" })).not.toEqual([]);
  });

  it("needs an id, an https documentation page and a date or null", () => {
    expect(allowProblems({ ...json, id: "" })).not.toEqual([]);
    expect(
      allowProblems({ ...json, docs: { url: "http://x.example/", checked: null } }),
    ).not.toEqual([]);
    expect(allowProblems({ ...json, docs: { url: DOCS.url, checked: "yesterday" } })).not.toEqual(
      [],
    );
    expect(allowProblems({ ...json, body: { kind: "json-query", keys: [] } })).not.toEqual([]);
    expect(allowProblems({ ...json, body: { kind: "form" } } as never)).not.toEqual([]);
  });
});

describe("queryRefusal", () => {
  const url = (s: string) => new URL(s);

  it("accepts the entry's host, path and body", () => {
    expect(
      queryRefusal(url("https://www.wixapis.example/wix-data/v2/items/query"), json, {
        dataCollectionId: "Menu",
      }),
    ).toBeUndefined();
  });

  it("refuses another host, another path, a query string, http, credentials and a port", () => {
    const body = { dataCollectionId: "Menu" };
    const bad = [
      "https://evil.example/wix-data/v2/items/query",
      "https://www.wixapis.example/wix-data/v2/items/insert",
      "https://www.wixapis.example/wix-data/v2/items/query?x=1",
      "http://www.wixapis.example/wix-data/v2/items/query",
      "https://u:p" + "@www.wixapis.example/wix-data/v2/items/query",
      "https://www.wixapis.example:8443/wix-data/v2/items/query",
    ];
    for (const b of bad) expect(queryRefusal(url(b), json, body), b).toBeDefined();
  });

  it("names the reason without echoing the body", () => {
    const why = queryRefusal(url("https://api.shop.example/graphql"), graphql, {
      query: "mutation { secretDelete }",
    });
    expect(why).toMatch(/mutation/);
    expect(why).not.toContain("secretDelete");
  });
});
