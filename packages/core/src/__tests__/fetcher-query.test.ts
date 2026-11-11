import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createFetcher,
  FetchError,
  type Fetcher,
  type QueryOptions,
  type Transport,
  type TransportRequest,
} from "../fetcher.js";
import { registerQueryAllow } from "../fetch/query-registry.js";
import { QueryRefusedError, type ReadOnlyQueryAllow } from "../fetch/read-only-query.js";

const DOCS = { url: "https://dev.vendor.example/query-items", checked: "2026-11-11" } as const;

const items = registerQueryAllow({
  id: "test-items-query",
  method: "POST",
  host: "api.vendor.example",
  path: "/v2/items/query",
  body: {
    kind: "json-query",
    keys: ["collection", "query", "sort"],
    operators: ["$eq", "$and"],
    enums: { sort: ["asc", "desc"] },
  },
  docs: DOCS,
});
const gql = registerQueryAllow({
  id: "test-shop-graphql",
  method: "POST",
  host: "api.vendor.example",
  path: "/graphql",
  body: { kind: "graphql-query", persisted: ["StoredProducts"] },
  docs: { ...DOCS, checked: null },
});
const configured = registerQueryAllow({
  id: "test-configured-graphql",
  method: "POST",
  host: { configured: "SHOP_GRAPHQL_URL" },
  path: "/graphql",
  body: { kind: "graphql-query" },
  docs: DOCS,
});

const URL_OK = "https://api.vendor.example/v2/items/query";
const GQL_URL = "https://api.vendor.example/graphql";
const KEY = ["sk", "live", "abcdefghijkl"].join("_");

interface Sent {
  url: string;
  req: TransportRequest;
}

function answering(
  status: number,
  headers: Record<string, string> = {},
  body = '{"items":[]}',
): { transport: Transport; sent: Sent[] } {
  const sent: Sent[] = [];
  const transport: Transport = (url, req) => {
    sent.push({ url: url.href, req });
    return Promise.resolve({
      status,
      headers: { "content-type": "application/json", ...headers },
      body: Readable.from([Buffer.from(body)]),
    });
  };
  return { transport, sent };
}

const q = (f: Fetcher) => {
  if (f.query === undefined) throw new Error("the real fetcher has query()");
  return f.query.bind(f);
};
const rejects = async (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );
const ask = (f: Fetcher, url: string, opts: QueryOptions) => rejects(q(f)(url, opts));

describe("fetcher.query: a POST only to a registered, documented read-only query", () => {
  it("sends the JSON body as a POST with the fetcher's content type, and returns the hop", async () => {
    const { transport, sent } = answering(200);
    const f = createFetcher({ transport });
    const hop = await q(f)(URL_OK, {
      allow: items.id,
      body: { collection: "Menu", query: { limit: 5 } },
    });
    expect(hop.status).toBe(200);
    expect(hop.body).toBe('{"items":[]}');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.req.method).toBe("POST");
    expect(sent[0]?.req.body).toBe('{"collection":"Menu","query":{"limit":5}}');
    expect(sent[0]?.req.headers["content-type"]).toBe("application/json");
    expect(sent[0]?.req.headers["user-agent"]).toMatch(/^Gaugeline\//);
  });

  it("get and head still refuse POST, PUT, PATCH and DELETE", async () => {
    const { transport, sent } = answering(200);
    const f = createFetcher({ transport });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const err = await rejects(
        Promise.resolve().then(() => f.get(URL_OK, { method: method as "GET" })),
      );
      expect(err, method).toBeInstanceOf(TypeError);
      expect(String(err)).toMatch(/read-only/);
    }
    expect(sent).toEqual([]);
  });

  describe("the allowlist is not self-attested", () => {
    it("refuses an id nobody registered", async () => {
      const { transport, sent } = answering(200);
      const f = createFetcher({ transport });
      const err = await ask(f, URL_OK, { allow: "never-registered", body: { collection: "x" } });
      expect(err).toBeInstanceOf(QueryRefusedError);
      expect(String(err)).toMatch(/no allowlist entry/);
      expect(sent).toEqual([]);
    });

    it("refuses an entry the caller wrote itself, whatever it says", async () => {
      const { transport, sent } = answering(200);
      const f = createFetcher({ transport });
      const own: ReadOnlyQueryAllow = {
        id: "shop-everything",
        method: "POST",
        host: "shop.example",
        path: "/*",
        body: { kind: "json-query", keys: ["name"] },
        docs: DOCS,
      };
      for (const allow of [own, { ...items, host: "shop.example" }])
        expect(
          await ask(f, "https://shop.example/anything", {
            allow: allow as unknown as string,
            body: { name: "x" },
          }),
        ).toBeInstanceOf(QueryRefusedError);
      // Naming a registered entry does not widen it either.
      expect(
        await ask(f, "https://shop.example/v2/items/query", {
          allow: items.id,
          body: { collection: "x" },
        }),
      ).toBeInstanceOf(QueryRefusedError);
      expect(sent).toEqual([]);
    });

    it("an entry with a configured host takes one exact host from the adapter, and no other", async () => {
      const { transport, sent } = answering(200);
      const f = createFetcher({ transport });
      const body = { query: "{ products { id } }" };
      const url = "https://shop.client.example/graphql";
      expect(
        (await q(f)(url, { allow: configured.id, host: "shop.client.example", body })).status,
      ).toBe(200);
      for (const host of [
        undefined,
        "*.client.example",
        "other.example",
        "https://shop.client.example",
      ])
        expect(
          await ask(f, url, {
            allow: configured.id,
            body,
            ...(host === undefined ? {} : { host }),
          }),
          String(host),
        ).toBeInstanceOf(QueryRefusedError);
      // A fixed-host entry is not given another host to use.
      expect(
        await ask(f, "https://other.example/v2/items/query", {
          allow: items.id,
          host: "other.example",
          body: { collection: "x" },
        }),
      ).toBeInstanceOf(QueryRefusedError);
      expect(sent).toHaveLength(1);
    });

    it("refuses a registration that is malformed, a path named like a write, or a clash", () => {
      const base = {
        method: "POST",
        host: "api.vendor.example",
        body: { kind: "graphql-query" },
        docs: DOCS,
      } as const;
      expect(() =>
        registerQueryAllow({ ...base, id: "bad-orders", path: "/orders/delete" }),
      ).toThrow(/named like a write/);
      expect(() => registerQueryAllow({ ...base, id: "bad-star", path: "/a/**" })).toThrow();
      expect(() =>
        registerQueryAllow({ ...base, id: "test-shop-graphql", path: "/other" }),
      ).toThrow(/already registered/);
      // The same entry again (a module loaded twice) is fine and gives back the frozen one.
      expect(registerQueryAllow({ ...gql })).toBe(gql);
      expect(Object.isFrozen(gql) && Object.isFrozen(gql.body) && Object.isFrozen(gql.docs)).toBe(
        true,
      );
    });
  });

  it("refuses a mutation, a subscription and a second operation, and sends nothing", async () => {
    const { transport, sent } = answering(200);
    const f = createFetcher({ transport });
    for (const query of [
      "mutation { deleteItem(id: 1) { id } }",
      "subscription { items { id } }",
      "query A { a } mutation B { b }",
    ]) {
      const err = await ask(f, GQL_URL, { allow: gql.id, body: { query } });
      expect(err, query).toBeInstanceOf(QueryRefusedError);
      expect(String(err)).not.toContain("deleteItem");
    }
    expect(sent).toEqual([]);
    const ok = await q(f)(GQL_URL, { allow: gql.id, body: { query: "{ items { id } }" } });
    expect(ok.status).toBe(200);
  });

  describe("persisted queries", () => {
    it("refuses a document together with any id or hash (the id could name a stored mutation)", async () => {
      const { transport, sent } = answering(200);
      const f = createFetcher({ transport });
      for (const extra of [
        { id: "StoredMutation" },
        { id: "StoredProducts" },
        { documentId: "x" },
        { queryId: "x" },
        { extensions: { persistedQuery: { version: 1, sha256Hash: "ab".repeat(32) } } },
      ])
        expect(
          await ask(f, GQL_URL, { allow: gql.id, body: { query: "{ a }", ...extra } }),
          JSON.stringify(extra),
        ).toBeInstanceOf(QueryRefusedError);
      expect(sent).toEqual([]);
    });

    it("accepts an id alone only when the entry names it", async () => {
      const { transport, sent } = answering(200);
      const f = createFetcher({ transport });
      expect((await q(f)(GQL_URL, { allow: gql.id, body: { id: "StoredProducts" } })).status).toBe(
        200,
      );
      for (const body of [
        { id: "StoredMutation" },
        { id: 7 },
        {},
        { id: "StoredProducts", documentId: "StoredProducts" },
      ])
        expect(await ask(f, GQL_URL, { allow: gql.id, body }), JSON.stringify(body)).toBeInstanceOf(
          QueryRefusedError,
        );
      // An entry with no persisted list takes no stored query at all.
      expect(
        await ask(f, "https://shop.client.example/graphql", {
          allow: configured.id,
          host: "shop.client.example",
          body: { id: "StoredProducts" },
        }),
      ).toBeInstanceOf(QueryRefusedError);
      expect(sent).toHaveLength(1);
    });
  });

  describe("the checked body is the sent body", () => {
    it("serialises once: a getter or toJSON that changes its answer cannot slip a write past the check", async () => {
      const { transport, sent } = answering(200);
      const f = createFetcher({ transport });
      let reads = 0;
      const sly = {
        get query() {
          reads += 1;
          return reads === 1 ? "{ a }" : "mutation { x }";
        },
      };
      await q(f)(GQL_URL, { allow: gql.id, body: sly });
      expect(JSON.parse(sent[0]?.req.body ?? "")).toEqual({ query: "{ a }" });
      let calls = 0;
      const toJson = {
        toJSON: () => (++calls === 1 ? { query: "{ a }" } : { query: "mutation { x }" }),
      };
      await q(f)(GQL_URL, { allow: gql.id, body: toJson as never });
      expect(JSON.parse(sent[1]?.req.body ?? "")).toEqual({ query: "{ a }" });
      expect(calls).toBe(1);
    });

    it("refuses a body that is not JSON", async () => {
      const { transport, sent } = answering(200);
      const f = createFetcher({ transport });
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      for (const body of [circular, { query: 10n }])
        expect(await ask(f, GQL_URL, { allow: gql.id, body: body as never })).toBeInstanceOf(
          QueryRefusedError,
        );
      expect(sent).toEqual([]);
    });
  });

  describe("a JSON query is checked all the way down", () => {
    it("refuses an operator that is not on the entry's list, a nested write key and a statement as a value", async () => {
      const { transport, sent } = answering(200);
      const f = createFetcher({ transport });
      const bad: Record<string, unknown>[] = [
        { collection: "Menu", query: { $set: { price: 0 } } },
        { collection: "Menu", query: { filter: { $where: "1" } } },
        { collection: "Menu", query: { filter: { $or: [] } } },
        { collection: "Menu", query: { filter: { insert: 1 } } },
        { collection: "Menu", query: { deleteitem: 1 } },
        { collection: "Menu", query: { bulkdelete: 1 } },
        { collection: "Menu", query: { UPDATEITEM: 1 } },
        { collection: "Menu", query: { items: [{ nested: { purge: true } }] } },
        { collection: "Menu", query: "DELETE FROM menu" },
        { collection: "Menu", query: { text: "update menu set price = 0" } },
        { collection: "Menu", query: "mutation { x }" },
        { collection: "Menu", sort: "sideways" },
      ];
      for (const body of bad)
        expect(
          await ask(f, URL_OK, { allow: items.id, body }),
          JSON.stringify(body),
        ).toBeInstanceOf(QueryRefusedError);
      expect(sent).toEqual([]);
    });

    it("accepts the vendor's operators and ordinary field names that hold a verb as a part", async () => {
      const { transport, sent } = answering(200);
      const f = createFetcher({ transport });
      const body = {
        collection: "Menu",
        sort: "asc",
        query: {
          filter: {
            $and: [
              { _createdDate: { $eq: "2026-01-01" } },
              { updatedBy: { $eq: "a" } },
              { address: "12 Elm" },
              { settings: { offset: 1 } },
            ],
          },
          text: "Updated menu for the winter",
        },
      };
      expect((await q(f)(URL_OK, { allow: items.id, body })).status).toBe(200);
      expect(sent).toHaveLength(1);
    });
  });

  it("refuses a key that is not a query key, a path outside the entry, another host, http and a query string", async () => {
    const { transport, sent } = answering(200);
    const f = createFetcher({ transport });
    expect(
      await ask(f, URL_OK, { allow: items.id, body: { collection: "x", extra: 1 } }),
    ).toBeInstanceOf(QueryRefusedError);
    for (const url of [
      "https://api.vendor.example/v2/items/insert",
      "https://api.vendor.example/v2/items/query/extra",
      "https://other.example/v2/items/query",
      "http://api.vendor.example/v2/items/query",
      "https://api.vendor.example/v2/items/query?x=1",
    ])
      expect(await ask(f, url, { allow: items.id, body: { collection: "x" } }), url).toBeInstanceOf(
        QueryRefusedError,
      );
    expect(sent).toEqual([]);
  });

  it("an address that does not parse is refused without repeating it (it may hold a key)", async () => {
    const { transport } = answering(200);
    const f = createFetcher({ transport });
    const err = await ask(f, `not a url ${KEY}`, { allow: items.id, body: { collection: "x" } });
    expect(err).toBeInstanceOf(QueryRefusedError);
    expect(String(err)).not.toContain(KEY);
  });

  it("refuses headers that change the method, the framing, the identity or the answer", async () => {
    const { transport, sent } = answering(200);
    const f = createFetcher({ transport });
    const names = [
      "X-HTTP-Method-Override",
      "x-http-method",
      "x-method-override",
      "X-Original-Method",
      "_method",
      "Content-Length",
      "Content-Type",
      "Host",
      "Cookie",
      "Expect",
      "Upgrade",
      "TE",
      "Proxy-Authorization",
      "Range",
      "User-Agent",
      "Accept-Encoding",
      "Transfer-Encoding",
    ];
    for (const name of names)
      expect(
        await ask(f, URL_OK, {
          allow: items.id,
          body: { collection: "x" },
          headers: { [name]: "DELETE" },
        }),
        name,
      ).toBeInstanceOf(QueryRefusedError);
    expect(sent).toEqual([]);
    // An ordinary key header is fine.
    await q(f)(URL_OK, {
      allow: items.id,
      body: { collection: "x" },
      headers: { Authorization: `Bearer ${KEY}`, "x-account-id": "a1" },
    });
    expect(sent).toHaveLength(1);
  });

  it("never follows a redirect: the body and headers go to one origin, and a 3xx is refused", async () => {
    for (const location of ["https://evil.example/collect", "/v2/items/other"]) {
      const { transport, sent } = answering(307, { location });
      const f = createFetcher({ transport });
      const err = await ask(f, URL_OK, {
        allow: items.id,
        body: { collection: "x" },
        headers: { authorization: `Bearer ${KEY}` },
      });
      expect(err).toBeInstanceOf(FetchError);
      expect((err as FetchError).reason).toBe("refused");
      expect(String(err)).not.toContain(KEY);
      expect(sent).toHaveLength(1);
    }
  });

  it("records the query in the request log with its allowlist id, and never the body or the key", async () => {
    const { transport } = answering(200);
    const f = createFetcher({ transport });
    await q(f)(URL_OK, {
      allow: items.id,
      body: { collection: "SecretCollection" },
      headers: { authorization: `Bearer ${KEY}` },
    });
    const log = f.history?.() ?? [];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      kind: "query",
      method: "POST",
      allow: "test-items-query",
      status: 200,
      url: URL_OK,
    });
    expect(JSON.stringify(log)).not.toContain(KEY);
    expect(JSON.stringify(log)).not.toContain("SecretCollection");
  });

  it("sends the key only in the header the caller gave, and not the protected-preview headers", async () => {
    const { transport, sent } = answering(200);
    const f = createFetcher({ transport, headersFor: () => ({ "x-preview-secret": "shh" }) });
    await q(f)(URL_OK, {
      allow: items.id,
      body: { collection: "x" },
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(sent[0]?.req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent[0]?.req.headers["x-preview-secret"]).toBeUndefined();
  });

  it("is not remembered: the same query twice is two requests", async () => {
    const { transport, sent } = answering(200);
    const f = createFetcher({ transport });
    await q(f)(URL_OK, { allow: items.id, body: { collection: "x" } });
    await q(f)(URL_OK, { allow: items.id, body: { collection: "x" } });
    expect(sent).toHaveLength(2);
    expect(f.stats.requests).toBe(2);
  });

  it("keeps the answer under the body cap, and the concurrency limit", async () => {
    const { transport } = answering(200, {}, "x".repeat(5000));
    const f = createFetcher({ transport, maxBodyBytes: 1000 });
    const hop = await q(f)(URL_OK, { allow: items.id, body: { collection: "x" } });
    expect(hop.truncated).toBe(true);
    expect(hop.bytes).toBe(1000);
    const lower = await q(f)(URL_OK, { allow: items.id, body: { collection: "x" }, maxBytes: 100 });
    expect(lower.bytes).toBe(100);
    let flight = 0;
    let most = 0;
    const slow: Transport = async () => {
      flight += 1;
      most = Math.max(most, flight);
      await new Promise((r) => setTimeout(r, 10));
      flight -= 1;
      return { status: 200, headers: {}, body: Readable.from([Buffer.from("{}")]) };
    };
    const g = createFetcher({ transport: slow, concurrency: 2 });
    await Promise.all(
      Array.from({ length: 6 }, () => q(g)(URL_OK, { allow: items.id, body: { collection: "x" } })),
    );
    expect(most).toBe(2);
  });

  it("a refused address (private) is still refused by the transport's rules, and logged as a query", async () => {
    const transport: Transport = () =>
      Promise.reject(
        new FetchError("private-address-refused", "api.vendor.example is private", URL_OK, []),
      );
    const f = createFetcher({ transport });
    const err = await ask(f, URL_OK, { allow: items.id, body: { collection: "x" } });
    expect((err as FetchError).reason).toBe("private-address-refused");
    expect(f.history?.()[0]).toMatchObject({
      kind: "query",
      status: null,
      error: "private-address-refused",
    });
  });
});
