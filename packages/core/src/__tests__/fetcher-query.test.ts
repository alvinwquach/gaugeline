import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createFetcher,
  FetchError,
  type Fetcher,
  type Transport,
  type TransportRequest,
} from "../fetcher.js";
import { QueryRefusedError, type ReadOnlyQueryAllow } from "../fetch/read-only-query.js";

const allow: ReadOnlyQueryAllow = {
  id: "items-query",
  method: "POST",
  host: "api.vendor.example",
  path: "/v2/items/query",
  body: { kind: "json-query", keys: ["collection", "query"] },
  docs: { url: "https://dev.vendor.example/query-items", checked: "2026-11-11" },
};
const gql: ReadOnlyQueryAllow = {
  id: "shop-graphql",
  method: "POST",
  host: "api.vendor.example",
  path: "/graphql",
  body: { kind: "graphql-query" },
  docs: { url: "https://dev.vendor.example/graphql", checked: null },
};
const URL_OK = "https://api.vendor.example/v2/items/query";
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
  return f.query;
};
const rejects = async (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("fetcher.query: a POST only to an allowlisted read-only query", () => {
  it("sends the JSON body as a POST with the fetcher's content type, and returns the hop", async () => {
    const { transport, sent } = answering(200);
    const f = createFetcher({ transport });
    const hop = await q(f).call(f, URL_OK, {
      allow,
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

  it("refuses a mutation, a subscription and a second operation, and sends nothing", async () => {
    const { transport, sent } = answering(200);
    const f = createFetcher({ transport });
    const url = "https://api.vendor.example/graphql";
    for (const query of [
      "mutation { deleteItem(id: 1) { id } }",
      "subscription { items { id } }",
      "query A { a } mutation B { b }",
    ]) {
      const err = await rejects(q(f).call(f, url, { allow: gql, body: { query } }));
      expect(err, query).toBeInstanceOf(QueryRefusedError);
      expect(String(err)).not.toContain("deleteItem");
    }
    expect(sent).toEqual([]);
    expect(
      (await q(f).call(f, url, { allow: gql, body: { query: "{ items { id } }" } })).status,
    ).toBe(200);
  });

  it("refuses a body with a key that is not a query key or is named like a write", async () => {
    const { transport, sent } = answering(200);
    const f = createFetcher({ transport });
    for (const body of [
      { collection: "Menu", insert: { name: "x" } },
      { collection: "Menu", dataItem: {} },
      { collection: "Menu", $set: { a: 1 } },
    ])
      expect(await rejects(q(f).call(f, URL_OK, { allow, body }))).toBeInstanceOf(
        QueryRefusedError,
      );
    expect(sent).toEqual([]);
  });

  it("refuses a path outside the entry, another host, an entry with PUT, and a bad entry", async () => {
    const { transport, sent } = answering(200);
    const f = createFetcher({ transport });
    const body = { collection: "Menu" };
    for (const url of [
      "https://api.vendor.example/v2/items/insert",
      "https://api.vendor.example/v2/items/query/extra",
      "https://other.example/v2/items/query",
      "http://api.vendor.example/v2/items/query",
      "https://api.vendor.example/v2/items/query?x=1",
      "not a url",
    ])
      expect(await rejects(q(f).call(f, url, { allow, body })), url).toBeInstanceOf(
        QueryRefusedError,
      );
    const put = { ...allow, method: "PUT" } as unknown as ReadOnlyQueryAllow;
    expect(await rejects(q(f).call(f, URL_OK, { allow: put, body }))).toBeInstanceOf(
      QueryRefusedError,
    );
    const wild = { ...allow, host: "*.vendor.example" };
    expect(await rejects(q(f).call(f, URL_OK, { allow: wild, body }))).toBeInstanceOf(
      QueryRefusedError,
    );
    expect(sent).toEqual([]);
  });

  it("refuses headers that change the method or the framing of the body", async () => {
    const { transport, sent } = answering(200);
    const f = createFetcher({ transport });
    for (const name of ["X-HTTP-Method-Override", "x-method-override", "Content-Length", "Host"])
      expect(
        await rejects(
          q(f).call(f, URL_OK, {
            allow,
            body: { collection: "Menu" },
            headers: { [name]: "DELETE" },
          }),
        ),
        name,
      ).toBeInstanceOf(QueryRefusedError);
    expect(sent).toEqual([]);
  });

  it("never follows a redirect: the body and headers go to one origin, and a 3xx is refused", async () => {
    for (const location of ["https://evil.example/collect", "/v2/items/other"]) {
      const { transport, sent } = answering(307, { location });
      const f = createFetcher({ transport });
      const err = await rejects(
        q(f).call(f, URL_OK, {
          allow,
          body: { collection: "Menu" },
          headers: { authorization: `Bearer ${KEY}` },
        }),
      );
      expect(err).toBeInstanceOf(FetchError);
      expect((err as FetchError).reason).toBe("refused");
      expect(String(err)).not.toContain(KEY);
      expect(sent).toHaveLength(1);
    }
  });

  it("records the query with its allowlist id, and never the body or the key", async () => {
    const { transport } = answering(200);
    const f = createFetcher({ transport });
    await q(f).call(f, URL_OK, {
      allow,
      body: { collection: "SecretCollection" },
      headers: { authorization: `Bearer ${KEY}` },
    });
    const log = f.queryHistory?.() ?? [];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      kind: "query",
      method: "POST",
      allow: "items-query",
      status: 200,
      url: URL_OK,
    });
    expect(JSON.stringify(log)).not.toContain(KEY);
    expect(JSON.stringify(log)).not.toContain("SecretCollection");
    // The page-request log (the published requests file: GET and HEAD) is unchanged.
    expect(f.history?.()).toEqual([]);
  });

  it("sends the key only in the header the caller gave, and not the protected-preview headers", async () => {
    const { transport, sent } = answering(200);
    const f = createFetcher({ transport, headersFor: () => ({ "x-preview-secret": "shh" }) });
    await q(f).call(f, URL_OK, {
      allow,
      body: { collection: "Menu" },
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(sent[0]?.req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent[0]?.req.headers["x-preview-secret"]).toBeUndefined();
  });

  it("is not remembered: the same query twice is two requests", async () => {
    const { transport, sent } = answering(200);
    const f = createFetcher({ transport });
    await q(f).call(f, URL_OK, { allow, body: { collection: "Menu" } });
    await q(f).call(f, URL_OK, { allow, body: { collection: "Menu" } });
    expect(sent).toHaveLength(2);
    expect(f.stats.requests).toBe(2);
  });

  it("keeps the answer under the body cap, and the concurrency limit", async () => {
    const { transport } = answering(200, {}, "x".repeat(5000));
    const f = createFetcher({ transport, maxBodyBytes: 1000 });
    const hop = await q(f).call(f, URL_OK, { allow, body: { collection: "Menu" } });
    expect(hop.truncated).toBe(true);
    expect(hop.bytes).toBe(1000);
    const lower = await q(f).call(f, URL_OK, {
      allow,
      body: { collection: "Menu" },
      maxBytes: 100,
    });
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
      Array.from({ length: 6 }, () =>
        q(g).call(g, URL_OK, { allow, body: { collection: "Menu" } }),
      ),
    );
    expect(most).toBe(2);
  });

  it("a refused address (private) is still refused by the transport's rules, recorded as a query", async () => {
    const transport: Transport = () =>
      Promise.reject(
        new FetchError("private-address-refused", "api.vendor.example is private", URL_OK, []),
      );
    const f = createFetcher({ transport });
    const err = await rejects(q(f).call(f, URL_OK, { allow, body: { collection: "Menu" } }));
    expect((err as FetchError).reason).toBe("private-address-refused");
    expect(f.queryHistory?.()[0]).toMatchObject({ status: null, error: "private-address-refused" });
  });
});
