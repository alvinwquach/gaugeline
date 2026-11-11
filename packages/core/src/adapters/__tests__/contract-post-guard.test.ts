import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, FetchError, type Transport } from "../../fetcher.js";
import { QueryRefusedError, type ReadOnlyQueryAllow } from "../../fetch/read-only-query.js";
import { allowlistProblems, recording, requestProblems, type Seen } from "./contract.js";

/**
 * The contract suite's guard on POST (ADR-0006) is not vacuous: it lets a documented read-only
 * query through, and fails an adapter that builds a mutation, a write-looking key, a POST outside
 * its allowlist, a PUT, PATCH or DELETE, or a POST with no allowlist at all.
 */
const DOCS = { url: "https://dev.vendor.example/query", checked: "2026-11-11" } as const;
const gqlAllow: ReadOnlyQueryAllow = {
  id: "shop-graphql",
  method: "POST",
  host: "api.vendor.example",
  path: "/graphql",
  body: { kind: "graphql-query" },
  docs: DOCS,
};
const jsonAllow: ReadOnlyQueryAllow = {
  id: "items-query",
  method: "POST",
  host: "api.vendor.example",
  path: "/v2/items/query",
  body: { kind: "json-query", keys: ["collection", "query"] },
  docs: { url: DOCS.url, checked: null },
};
const allows = [gqlAllow, jsonAllow];

const post = (path: string, body: unknown, method = "POST"): Seen => ({
  method,
  url: `https://api.vendor.example${path}`,
  headers: {},
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("requestProblems with an allowlist", () => {
  it("lets a GraphQL query and a JSON query through, to their own paths", () => {
    expect(
      requestProblems(
        [
          post("/graphql", { query: "query Q { items { id } }" }),
          post("/v2/items/query", { collection: "Menu", query: { limit: 3 } }),
          { method: "GET", url: "https://api.vendor.example/health", headers: {} },
        ],
        allows,
      ),
    ).toEqual([]);
  });

  it("refuses a POST when the adapter declares no allowlist", () => {
    expect(requestProblems([post("/graphql", { query: "{ a }" })])).toHaveLength(1);
    expect(requestProblems([post("/graphql", { query: "{ a }" })], [])).toHaveLength(1);
  });

  it("refuses a GraphQL mutation and a subscription in a body, without repeating the body", () => {
    for (const query of [
      "mutation { deleteItem(id: 1) { id } }",
      "subscription { items { id } }",
    ]) {
      const got = requestProblems([post("/graphql", { query })], allows);
      expect(got).toHaveLength(1);
      expect(got[0]).not.toContain("deleteItem");
    }
  });

  it("refuses a JSON body with a write-looking key, a key off the list, or text that is not JSON", () => {
    for (const body of [
      { collection: "Menu", insert: { a: 1 } },
      { collection: "Menu", extra: 1 },
      "not json",
    ])
      expect(requestProblems([post("/v2/items/query", body)], allows)).toHaveLength(1);
  });

  it("refuses a POST to a path or host outside the allowlist, and to http", () => {
    expect(requestProblems([post("/v2/items/insert", { collection: "x" })], allows)).toHaveLength(
      1,
    );
    expect(requestProblems([post("/graphql/", { query: "{ a }" })], allows)).toHaveLength(1);
    const elsewhere = { ...post("/graphql", { query: "{ a }" }), url: "https://x.example/graphql" };
    expect(requestProblems([elsewhere], allows)).toHaveLength(1);
    const plain = {
      ...post("/graphql", { query: "{ a }" }),
      url: "http://api.vendor.example/graphql",
    };
    expect(requestProblems([plain], allows)).toHaveLength(1);
  });

  it("refuses PUT, PATCH and DELETE even to an allowlisted path with a harmless body", () => {
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"])
      expect(
        requestProblems([post("/v2/items/query", { collection: "x" }, method)], allows),
        method,
      ).toHaveLength(1);
  });

  it("refuses a malformed entry: a write-looking query key, a wildcard host, http docs, a repeated id", () => {
    const keys = ["query", "update"];
    expect(allowlistProblems([{ ...jsonAllow, body: { kind: "json-query", keys } }])).not.toEqual(
      [],
    );
    expect(allowlistProblems([{ ...gqlAllow, host: "*.vendor.example" }])).not.toEqual([]);
    const http = { url: "http://dev.vendor.example/", checked: null };
    expect(allowlistProblems([{ ...gqlAllow, docs: http }])).not.toEqual([]);
    expect(allowlistProblems([gqlAllow, { ...jsonAllow, id: gqlAllow.id }])).not.toEqual([]);
    expect(allowlistProblems(allows)).toEqual([]);
  });
});

describe("a bad adapter fails the suite", () => {
  const ok: Transport = () =>
    Promise.resolve({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.from("{}")]),
    });

  const asked = async (
    transport: Transport,
    url: string,
    allow: ReadOnlyQueryAllow,
    body: Record<string, unknown>,
  ) => {
    const seen: Seen[] = [];
    const f = createFetcher({ transport: recording(transport, seen) });
    if (f.query === undefined) throw new Error("the real fetcher has query()");
    const err = await f.query(url, { allow, body }).then(
      () => undefined,
      (e: unknown) => e,
    );
    return { err, seen };
  };

  it("a mutation, a write key and a path outside the allowlist are refused before they are sent", async () => {
    const cases: Array<[string, ReadOnlyQueryAllow, Record<string, unknown>]> = [
      ["https://api.vendor.example/graphql", gqlAllow, { query: "mutation { x }" }],
      ["https://api.vendor.example/v2/items/query", jsonAllow, { collection: "a", remove: 1 }],
      ["https://api.vendor.example/v2/items/remove", jsonAllow, { collection: "a" }],
    ];
    for (const [url, allow, body] of cases) {
      const { err, seen } = await asked(ok, url, allow, body);
      expect(err, url).toBeInstanceOf(QueryRefusedError);
      expect(seen).toEqual([]);
    }
  });

  it("a redirect off-origin is refused and the body goes nowhere else", async () => {
    const redirect: Transport = () =>
      Promise.resolve({
        status: 307,
        headers: { location: "https://evil.example/collect" },
        body: Readable.from([]),
      });
    const { err, seen } = await asked(redirect, "https://api.vendor.example/graphql", gqlAllow, {
      query: "{ a }",
    });
    expect(err).toBeInstanceOf(FetchError);
    expect(seen.map((s) => s.url)).toEqual(["https://api.vendor.example/graphql"]);
  });

  it("a request that reached the transport by some other road is still caught by the guard", () => {
    const leaked: Seen[] = [
      post("/graphql", { query: "mutation { x }" }),
      post("/v2/items/query", { collection: "a", delete: true }),
      post("/other", { query: "{ a }" }),
      post("/graphql", { query: "{ a }" }, "DELETE"),
    ];
    expect(requestProblems(leaked, allows)).toHaveLength(4);
  });

  it("the transport really records the body of a query that was allowed", async () => {
    const { err, seen } = await asked(ok, "https://api.vendor.example/graphql", gqlAllow, {
      query: "{ items { id } }",
    });
    expect(err).toBeUndefined();
    expect(seen[0]?.body).toBe('{"query":"{ items { id } }"}');
    expect(requestProblems(seen, allows)).toEqual([]);
  });
});
