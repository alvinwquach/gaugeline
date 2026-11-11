import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import {
  createShopifyAdapter,
  readQuery,
  safePath,
  shopHost,
  SHOPIFY_STOREFRONT_QUERY,
} from "../shopify.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "../types.js";
import {
  SHOPIFY_SHOP,
  SHOPIFY_MARKERS,
  shopifyTransport,
  type FixtureNode,
} from "./shopify-fixture.js";

/**
 * What is particular to the Shopify adapter. The rules every adapter shares are in the contract suite
 * (contract.test.ts); this file is the Storefront API's own behaviour and a hostile server.
 */
const TOKEN = ["shpat", "test", "0123456789abcdef"].join("_");
const ENV = { SHOPIFY_STOREFRONT_TOKEN: TOKEN, SHOPIFY_SHOP_DOMAIN: SHOPIFY_SHOP };
const noWait = () => Promise.resolve();

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

interface Over {
  env?: Record<string, string>;
  transport?: Transport;
  pageSize?: number;
  maxItemsPerType?: number;
  sleeps?: number[];
}

function make(over: Over = {}) {
  const sleeps = over.sleeps ?? [];
  const adapter = createShopifyAdapter({
    env: over.env ?? ENV,
    fetcher: createFetcher({
      transport: over.transport ?? shopifyTransport(undefined, { token: TOKEN }),
      timeoutMs: 5000,
    }),
    sleep: (ms) => {
      sleeps.push(ms);
      return noWait();
    },
    ...(over.pageSize === undefined ? {} : { pageSize: over.pageSize }),
    ...(over.maxItemsPerType === undefined ? {} : { maxItemsPerType: over.maxItemsPerType }),
  });
  return { adapter, sleeps };
}

/** A transport that answers every connection query with what `fn` gives for the page of nodes asked for. */
const connection =
  (fn: (n: number) => unknown): Transport =>
  () => {
    let n = 0;
    return reply(200, fn(n++));
  };

const failure = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("the Shopify adapter: what it reads", () => {
  it("a product hidden from the Online Store is not counted, delivered or reported missing", async () => {
    const { adapter } = make();
    const products = (await adapter.types()).find((t) => t.name === "products");
    expect(products?.count).toBe(2);
    const { docs } = await collectPublished(adapter, { types: ["products"] });
    expect(docs.map((d) => d.slug)).toEqual(["mug-speckled", "bowl-ash-glaze"]);
    expect(JSON.stringify(docs)).not.toContain("kiln-seconds-box");
  });

  it("gives an item's path from the platform, never its host, and the settings' pattern wins when one is set", async () => {
    const { docs } = await collectPublished(make().adapter, { types: ["articles", "pages"] });
    expect(docs.map((d) => d.url)).toEqual([
      "/blogs/news/spring-glaze-test",
      "/pages/about",
      "/pages/studio-hours",
    ]);
    const adapter = createShopifyAdapter({
      env: ENV,
      fetcher: createFetcher({ transport: shopifyTransport(), timeoutMs: 5000 }),
      settings: { id: "shopify", urls: { pages: "/p/{slug}" } },
      sleep: noWait,
    });
    expect((await collectPublished(adapter, { types: ["pages"] })).docs[0]?.url).toBe("/p/about");
  });

  it("asks only for the fields that are needed, and never one it was not allowed to name", async () => {
    const asked: string[] = [];
    const transport = shopifyTransport(undefined, {
      token: TOKEN,
      onRequest: (_m, _u, body) => asked.push(String(JSON.parse(body ?? "{}").query)),
    });
    const { adapter } = make({ transport });
    await collectPublished(adapter, { types: ["products"] });
    expect(asked.at(-1)).not.toMatch(/title|description|seo/);
    await collectPublished(adapter, {
      types: ["products"],
      fields: { products: ["title", "seo.title", "seo.description", "subtitle", "x } y { z"] },
    });
    const q = asked.at(-1) ?? "";
    expect(q).toContain("title");
    expect(q).toContain("seo { title description }");
    expect(q).not.toMatch(/subtitle|\bz\b/);
  });

  it("sends a GraphQL query to the shop's own address with the token in a header only", async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const base = shopifyTransport(undefined, { token: TOKEN });
    const transport: Transport = (url, req) => {
      seen.push({ url: url.href, headers: req.headers, body: req.body ?? "" });
      return base(url, req);
    };
    await make({ transport }).adapter.draftsReachable();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`https://${SHOPIFY_SHOP}/api/2025-07/graphql.json`);
    expect(seen[0]?.url).not.toContain(TOKEN);
    expect(seen[0]?.headers["x-shopify-storefront-access-token"]).toBe(TOKEN);
    expect(seen[0]?.body).not.toContain(TOKEN);
    expect(seen[0]?.body).not.toMatch(/mutation|subscription/i);
    expect(JSON.parse(seen[0]?.body ?? "{}")).toHaveProperty("query");
  });

  it("the allowlist entry is a frozen POST for one GraphQL query to the shop's own host", () => {
    expect(Object.isFrozen(SHOPIFY_STOREFRONT_QUERY)).toBe(true);
    expect(SHOPIFY_STOREFRONT_QUERY.host).toEqual({ configured: "SHOPIFY_SHOP_DOMAIN" });
    expect(SHOPIFY_STOREFRONT_QUERY.path).toBe("/api/*/graphql.json");
    expect(SHOPIFY_STOREFRONT_QUERY.body.kind).toBe("graphql-query");
    expect(readQuery("products", ["title"])).toMatch(/^query /);
  });

  it("uses the API version setting, and refuses one that is not a quarterly release", async () => {
    const seen: string[] = [];
    const transport = shopifyTransport(undefined, { onRequest: (_m, u) => seen.push(u.pathname) });
    await collectPublished(
      make({ env: { ...ENV, SHOPIFY_API_VERSION: "2025-10" }, transport }).adapter,
      { types: ["blogs"] },
    ).catch(() => undefined);
    expect(seen[0]).toBe("/api/2025-10/graphql.json");
    const err = await failure(
      make({ env: { ...ENV, SHOPIFY_API_VERSION: "../x" } }).adapter.draftsReachable(),
    );
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  });
});

describe("the Shopify adapter: settings that are empty or wrong are could-not-check, and nothing is asked", () => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ["no token", { SHOPIFY_SHOP_DOMAIN: SHOPIFY_SHOP }, /SHOPIFY_STOREFRONT_TOKEN is not set/],
    ["no shop", { SHOPIFY_STOREFRONT_TOKEN: TOKEN }, /SHOPIFY_SHOP_DOMAIN is not set/],
    ["a blank shop", { ...ENV, SHOPIFY_SHOP_DOMAIN: "   " }, /not set/],
    [
      "a host that is not myshopify.com",
      { ...ENV, SHOPIFY_SHOP_DOMAIN: "shop.example.com" },
      /not a myshopify\.com address/,
    ],
    [
      "a host that only ends in myshopify.com",
      { ...ENV, SHOPIFY_SHOP_DOMAIN: "evil.example/.myshopify.com" },
      /not a myshopify\.com address/,
    ],
    [
      "a token with a space in it",
      { ...ENV, SHOPIFY_STOREFRONT_TOKEN: "a b" },
      /not a plain token/,
    ],
  ];
  it.each(cases)("%s", async (_name, env, reason) => {
    const seen: string[] = [];
    const transport = shopifyTransport(undefined, { onRequest: (_m, u) => seen.push(u.href) });
    const err = await failure(make({ env, transport }).adapter.types());
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).toMatch(reason);
    expect((err as AdapterCouldNotCheck).reason).not.toContain(TOKEN);
    expect(seen).toEqual([]);
  });

  it("shopHost accepts the spec's shape (and the bare handle) and nothing else", () => {
    expect(shopHost("larkspur-ceramics")).toBe("larkspur-ceramics.myshopify.com");
    expect(shopHost(" Larkspur-Ceramics.myshopify.com ")).toBe("larkspur-ceramics.myshopify.com");
    for (const bad of [
      "",
      "-a.myshopify.com",
      "a.myshopify.com.evil.example",
      "a.myshopify.com:8443",
      "https://a.myshopify.com",
      "a_b.myshopify.com",
      `${"a".repeat(62)}.myshopify.com`,
    ])
      expect(shopHost(bad)).toBeUndefined();
  });
});

describe("the Shopify adapter: pagination against a hostile server", () => {
  const nodes = (n: number): FixtureNode[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `gid://shopify/Page/${9000 + i}`,
      handle: `page-${i}`,
      onlineStoreUrl: `https://x.example/pages/page-${i}`,
      updatedAt: "2026-10-10T09:00:00Z",
    }));

  it("reads a list by cursor and gives the same items for a page of 1 as for a big one", async () => {
    const small = (await collectPublished(make({ pageSize: 1 }).adapter, { types: ["pages"] }))
      .docs;
    const big = (await collectPublished(make().adapter, { types: ["pages"] })).docs;
    expect(small.map((d) => d.id)).toEqual(["3001", "3002"]);
    expect(small).toEqual(big);
  });

  it("the same cursor forever is could-not-check, never a long loop and never complete", async () => {
    let calls = 0;
    const transport = connection(() => {
      calls++;
      return {
        data: { pages: { nodes: nodes(1), pageInfo: { hasNextPage: true, endCursor: "same" } } },
      };
    });
    const err = await failure(
      collectPublished(make({ transport, pageSize: 1 }).adapter, { types: ["pages"] }),
    );
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("hasNextPage with no cursor is could-not-check", async () => {
    const transport = connection(() => ({
      data: { pages: { nodes: nodes(1), pageInfo: { hasNextPage: true, endCursor: null } } },
    }));
    const err = await failure(collectPublished(make({ transport }).adapter, { types: ["pages"] }));
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).toMatch(/no usable cursor/);
  });

  it("an empty page that says there is more is could-not-check", async () => {
    const transport = connection(() => ({
      data: { pages: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "next" } } },
    }));
    const err = await failure(collectPublished(make({ transport }).adapter, { types: ["pages"] }));
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  });

  it("a page bigger than the one asked for is refused, not clamped and called complete", async () => {
    const transport = connection(() => ({
      data: { pages: { nodes: nodes(11), pageInfo: { hasNextPage: false, endCursor: null } } },
    }));
    const err = await failure(
      collectPublished(make({ transport, pageSize: 10 }).adapter, { types: ["pages"] }),
    );
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).toMatch(/more .* than were asked/);
  });

  it("a cursor that is absurdly long is refused", async () => {
    const transport = connection(() => ({
      data: {
        pages: { nodes: nodes(1), pageInfo: { hasNextPage: true, endCursor: "c".repeat(100_000) } },
      },
    }));
    const err = await failure(collectPublished(make({ transport }).adapter, { types: ["pages"] }));
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  });

  it("a type past the bound is could-not-check, never a count of part of it", async () => {
    const err = await failure(
      make({ maxItemsPerType: 1, pageSize: 1 }).adapter.fieldCounts("pages", ["title"]),
    );
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).toMatch(/more than 1 pages/);
  });

  it("a read with a limit stops at the limit without the bound being an error", async () => {
    const { docs } = await collectPublished(make({ maxItemsPerType: 1, pageSize: 1 }).adapter, {
      types: ["pages"],
      limit: 1,
    });
    expect(docs).toHaveLength(1);
  });
});

describe("the Shopify adapter: answers that are not what they should be", () => {
  const withNode = (node: Record<string, unknown>): Transport =>
    connection(() => ({
      data: { pages: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } } },
    }));
  const good = {
    id: "gid://shopify/Page/1",
    handle: "about",
    onlineStoreUrl: "https://x.example/pages/about",
    updatedAt: "2026-10-10T09:00:00Z",
  };

  it("GraphQL errors in a 200 are could-not-check, never an empty list, and say nothing of what they quote", async () => {
    const transport = connection(() => ({ errors: [{ message: SHOPIFY_MARKERS.about }] }));
    const err = await failure(collectPublished(make({ transport }).adapter, { types: ["pages"] }));
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).toBe("Shopify answered with 1 error.");
  });

  it("a missing data object is could-not-check", async () => {
    const err = await failure(
      collectPublished(make({ transport: connection(() => ({})) }).adapter, { types: ["pages"] }),
    );
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  });

  it("an answer that is not JSON is could-not-check", async () => {
    const transport: Transport = () =>
      Promise.resolve({
        status: 200,
        headers: { "content-type": "text/html" },
        body: Readable.from([Buffer.from(`<html>${SHOPIFY_MARKERS.about}</html>`)]),
      });
    const err = await failure(make({ transport }).adapter.types());
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).not.toContain(SHOPIFY_MARKERS.about);
  });

  it("THROTTLED is waited out once, then it is a rate limit that keeps what was read", async () => {
    const throttled = {
      errors: [{ extensions: { code: "THROTTLED", cost: { requestedQueryCost: 900 } } }],
    };
    let n = 0;
    const base = shopifyTransport(undefined, { token: TOKEN });
    const transport: Transport = (url, req) => (n++ >= 1 ? reply(200, throttled) : base(url, req));
    const sleeps: number[] = [];
    const err = await failure(
      collectPublished(make({ transport, sleeps }).adapter, { types: ["pages", "products"] }),
    );
    // collectPublished turns the rate limit into a partial result: it is not thrown.
    expect(err).toBeUndefined();
    expect(sleeps).toEqual([1000]);
    const types = await failure(make({ transport: () => reply(200, throttled) }).adapter.types());
    expect(types).toBeInstanceOf(AdapterRateLimitedError);
  });

  it("a 429 with Retry-After is waited out once", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const base = shopifyTransport(undefined, { token: TOKEN });
    const transport: Transport = (url, req) =>
      n++ === 0 ? reply(429, {}, { "retry-after": "2.0" }) : base(url, req);
    const { docs } = await collectPublished(make({ transport, sleeps }).adapter, {
      types: ["pages"],
    });
    expect(sleeps).toEqual([2000]);
    expect(docs).toHaveLength(2);
  });

  it("a token that may not read one part is could-not-check for that part only", async () => {
    const base = shopifyTransport(undefined, { token: TOKEN });
    const transport: Transport = (url, req) =>
      /\{ pages\(/.test(req.body ?? "")
        ? reply(200, { errors: [{ extensions: { code: "ACCESS_DENIED" } }] })
        : base(url, req);
    const { adapter } = make({ transport });
    const err = await failure(adapter.types());
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).toContain("unauthenticated_read_content");
    expect((await collectPublished(adapter, { types: ["products"] })).docs).toHaveLength(2);
  });

  it("a redirect is never followed: the token and the body go to one origin only", async () => {
    const hosts: string[] = [];
    const transport: Transport = (url) => {
      hosts.push(url.host);
      return reply(302, {}, { location: "https://elsewhere.example/api/2025-07/graphql.json" });
    };
    const err = await failure(make({ transport }).adapter.types());
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect(hosts).toEqual([SHOPIFY_SHOP]);
  });

  it("a refused token is could-not-check with the variable named and the token never in the reason", async () => {
    const err = await failure(make({ transport: () => reply(401, {}) }).adapter.types());
    expect((err as AdapterCouldNotCheck).reason).toContain("SHOPIFY_STOREFRONT_TOKEN");
    expect((err as AdapterCouldNotCheck).reason).not.toContain(TOKEN);
  });

  it.each([
    ["an id that is not a Shopify id", { ...good, id: "1" }],
    ["an id of another kind", { ...good, id: "gid://shopify/Product/1" }],
    ["a handle with a slash", { ...good, handle: "a/b" }],
    ["a handle that starts with a dot", { ...good, handle: "..x" }],
    ["an address on another scheme", { ...good, onlineStoreUrl: "http://x.example/pages/a" }],
    [
      "a protocol-relative address",
      { ...good, onlineStoreUrl: "https://x.example//evil.example/a" },
    ],
    [
      "an address with a dot segment",
      { ...good, onlineStoreUrl: "https://x.example/pages/%2e%2e/../a" },
    ],
    [
      "an address with a lone surrogate",
      { ...good, onlineStoreUrl: "https://x.example/pages/\ud800" },
    ],
    ["a missing update time", { ...good, updatedAt: null }],
  ])("%s is could-not-check, and never throws anything else", async (_name, node) => {
    const err = await failure(
      collectPublished(make({ transport: withNode(node) }).adapter, { types: ["pages"] }),
    );
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  });

  it("safePath keeps a plain path and refuses the rest", () => {
    expect(safePath("https://x.example/products/mug-speckled?variant=1")).toBe(
      "/products/mug-speckled",
    );
    expect(safePath("https://x.example/")).toBe("/");
    for (const bad of [
      null,
      5,
      "http://x.example/a",
      "https://x.example//a",
      "/a",
      "https://x.example/a/../b",
    ])
      expect(safePath(bad)).toBeUndefined();
  });
});
