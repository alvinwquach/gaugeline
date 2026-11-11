import { describe, expect, it } from "vitest";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import {
  createSquarespaceCommerceAdapter,
  type SquarespaceCommerceAdapter,
} from "../squarespace-commerce.js";
import { AdapterCouldNotCheck } from "../types.js";
import {
  SQUARESPACE_COMMERCE_MARKERS,
  SQUARESPACE_COMMERCE_PRODUCTS,
  squarespaceCommerceTransport,
  type FixtureProduct,
  type SquarespaceCommerceFixtureOptions,
} from "./squarespace-commerce-fixture.js";

/**
 * What is particular to the Squarespace commerce adapter. The rules every adapter shares (counts and
 * fingerprints but never a value, no request but GET or HEAD, a refused key is could-not-check, a rate limit
 * is waited out once) are in the contract suite: no test here repeats them.
 */
const KEY = testKey("squarespace-commerce-own");
const noWait = () => Promise.resolve();

function make(
  over: {
    api?: SquarespaceCommerceFixtureOptions;
    products?: readonly FixtureProduct[];
    maxItemsPerType?: number;
    maxPagesPerList?: number;
    urls?: Record<string, string>;
  } = {},
): { adapter: SquarespaceCommerceAdapter; seen: string[] } {
  const seen: string[] = [];
  const adapter = createSquarespaceCommerceAdapter({
    env: { SQUARESPACE_COMMERCE_TOKEN: KEY },
    fetcher: createFetcher({
      transport: squarespaceCommerceTransport(over.products, {
        token: KEY,
        onRequest: (_m, url) => seen.push(url.href),
        ...over.api,
      }),
      timeoutMs: 5000,
    }),
    ...(over.urls ? { settings: { id: "squarespace-commerce", urls: over.urls } } : {}),
    ...(over.maxItemsPerType !== undefined ? { maxItemsPerType: over.maxItemsPerType } : {}),
    ...(over.maxPagesPerList !== undefined ? { maxPagesPerList: over.maxPagesPerList } : {}),
    sleep: noWait,
  });
  return { adapter, seen };
}

const couldNotCheck = async (p: Promise<unknown>): Promise<string> => {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

describe("the Squarespace commerce adapter: reading products", () => {
  it("steps by the cursor each page returns, and gives the same products whatever the page size", async () => {
    const small = make({ api: { pageSize: 1 } });
    const big = make({ api: { pageSize: 100 } });
    const a = (await collectPublished(small.adapter)).docs;
    const b = (await collectPublished(big.adapter)).docs;
    expect(a.map((d) => d.id)).toEqual(["p-dawn", "p-tote", "p-zine"]);
    expect(a).toEqual(b);
    expect(small.seen).toHaveLength(4);
    expect(big.seen).toHaveLength(1);
  });

  it("never follows the address the API gives for the next page, only its cursor", async () => {
    const { adapter, seen } = make();
    await collectPublished(adapter);
    expect(seen.some((u) => u.includes("elsewhere.example"))).toBe(false);
    expect(seen.every((u) => u.startsWith("https://api.squarespace.com/1.0/commerce/"))).toBe(true);
  });

  it("a hidden product is a draft: not published, but a key that sees it makes drafts reachable", async () => {
    const { adapter } = make();
    const docs = (await collectPublished(adapter)).docs;
    expect(docs.some((d) => d.id === "p-cards")).toBe(false);
    expect(await adapter.draftsReachable()).toBe(true);
    const shown = SQUARESPACE_COMMERCE_PRODUCTS.filter((p) => p.isVisible);
    expect(await make({ products: shown }).adapter.draftsReachable()).toBe(false);
  });

  it("gives the page address the API names, or the settings' pattern, never a made-up one", async () => {
    const docs = (await collectPublished(make().adapter)).docs;
    expect(docs.find((d) => d.id === "p-dawn")?.url).toBe("/shop/harbour-at-dawn");
    const noUrl = SQUARESPACE_COMMERCE_PRODUCTS.map((p) => ({ ...p, url: "" }));
    expect(
      (await collectPublished(make({ products: noUrl }).adapter)).docs[0]?.url,
    ).toBeUndefined();
    const patterned = make({ products: noUrl, urls: { products: "/shop/{slug}" } });
    expect((await collectPublished(patterned.adapter)).docs[0]?.url).toBe("/shop/harbour-at-dawn");
    // A pattern that would make "//host" is another site, not a path on this one.
    const hostile = make({ products: noUrl, urls: { products: "//evil.example/{slug}" } });
    expect((await collectPublished(hostile.adapter)).docs[0]?.url).toBeUndefined();
  });

  it("uses only a safe path from the API: not //host, not .., not a query, not another scheme", async () => {
    const urls = [
      "//evil.example/shop/a",
      "/shop/../admin",
      "/shop/a?x=1",
      "javascript:alert(1)",
      "http://insecure.example/shop/a",
      "/shop/a\\b",
      "https://shop.example/shop/ok",
    ];
    const products = urls.map((url, i) => ({
      ...SQUARESPACE_COMMERCE_PRODUCTS[0]!,
      id: `p-${i}`,
      url,
    }));
    const docs = (await collectPublished(make({ products }).adapter)).docs;
    expect(docs.map((d) => d.url)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "/shop/ok",
    ]);
  });

  it("drops a slug that is not a plain identifier and refuses a product whose id is not", async () => {
    const odd = [
      { ...SQUARESPACE_COMMERCE_PRODUCTS[0]!, urlSlug: "bad slug/../x" },
      { ...SQUARESPACE_COMMERCE_PRODUCTS[1]!, urlSlug: "\ud800lone" },
    ];
    const docs = (await collectPublished(make({ products: odd }).adapter)).docs;
    expect(docs.map((d) => d.slug)).toEqual([undefined, undefined]);
    const badId = [{ ...SQUARESPACE_COMMERCE_PRODUCTS[0]!, id: "../etc" }];
    const reason = await couldNotCheck(make({ products: badId }).adapter.types());
    expect(reason).toMatch(/no usable id/);
  });

  it("reads a price as whole minor units, the sale price while a variant is on sale", async () => {
    const { products } = await make().adapter.catalogue();
    const dawn = products.find((p) => p.id === "p-dawn");
    expect(dawn?.variants).toEqual([
      { id: "v-dawn-a4", price: 2800, currency: "usd" },
      { id: "v-dawn-a3", price: 4500, currency: "usd" },
    ]);
    expect(products.find((p) => p.id === "p-tote")?.variants[0]?.price).toBe(3200);
    const odd = SQUARESPACE_COMMERCE_PRODUCTS.map((p) => ({
      ...p,
      variants: p.variants.map((v) => ({ ...v, base: "1e3", currency: "USD" })),
    }));
    const got = (await make({ products: odd }).adapter.catalogue()).products[0]?.variants[0];
    expect(got).toEqual({ id: "v-dawn-a4" });
  });

  it("keeps no name or description in what the catalogue returns", async () => {
    const text = JSON.stringify(await make().adapter.catalogue());
    for (const marker of Object.values(SQUARESPACE_COMMERCE_MARKERS))
      expect(text).not.toContain(marker);
  });

  it("a type other than products is could-not-check and says pages and blogs have no read API", async () => {
    const reason = await couldNotCheck(make().adapter.fieldCounts("pages", ["title"]));
    expect(reason).toContain('"pages"');
    expect(reason).toContain("Pages and blog posts have no read API");
  });

  it("with no key set it says which variable to set and asks for nothing", async () => {
    const seen: string[] = [];
    const adapter = createSquarespaceCommerceAdapter({
      env: {},
      fetcher: createFetcher({
        transport: squarespaceCommerceTransport(undefined, {
          onRequest: (_m, url) => seen.push(url.href),
        }),
        timeoutMs: 5000,
      }),
      sleep: noWait,
    });
    expect(await couldNotCheck(adapter.types())).toContain("SQUARESPACE_COMMERCE_TOKEN");
    expect(seen).toEqual([]);
  });
});

describe("the Squarespace commerce adapter: a server that does not stop", () => {
  const paging =
    (next: (page: number) => unknown): SquarespaceCommerceFixtureOptions["paging"] =>
    (_list, page) =>
      next(page);

  it("a cursor that repeats ends the read as could-not-check", async () => {
    const { adapter } = make({
      api: { paging: paging(() => ({ hasNextPage: true, nextPageCursor: "c1" })) },
    });
    expect(await couldNotCheck(adapter.types())).toMatch(/missing, repeated or unusable cursor/);
  });

  it("a page that says there is more and names no cursor is could-not-check, not the end", async () => {
    const { adapter } = make({ api: { paging: paging(() => ({ hasNextPage: true })) } });
    expect(await couldNotCheck(adapter.types())).toMatch(/cursor/);
  });

  it("a cursor with characters that do not belong in one is never put in an address", async () => {
    const { adapter, seen } = make({
      api: {
        paging: paging(() => ({ hasNextPage: true, nextPageCursor: "c1&key=1/../../x" })),
      },
    });
    await couldNotCheck(adapter.types());
    expect(seen).toHaveLength(1);
  });

  it("a list with no pagination object is not the shape the API sends", async () => {
    const { adapter } = make({ api: { paging: paging(() => "nothing") } });
    expect(await couldNotCheck(adapter.types())).toMatch(/not a page of products/);
  });

  it("endless fresh cursors stop at the page bound", async () => {
    const { adapter, seen } = make({
      maxPagesPerList: 3,
      api: {
        pageSize: 1,
        paging: paging((n) => ({ hasNextPage: true, nextPageCursor: `c${n + 1}` })),
      },
    });
    expect(await couldNotCheck(adapter.types())).toMatch(/longer than 3 pages/);
    expect(seen).toHaveLength(3);
  });

  it("a store bigger than the bound is could-not-check, never a count of part of it", async () => {
    const reason = await couldNotCheck(make({ maxItemsPerType: 2 }).adapter.types());
    expect(reason).toMatch(/more than 2 products/);
  });

  it("a rate limit that stays keeps what was read, as partial", async () => {
    // The first page is answered and the rest asks Gaugeline to slow down.
    let n = 0;
    const limited = createSquarespaceCommerceAdapter({
      env: { SQUARESPACE_COMMERCE_TOKEN: KEY },
      fetcher: createFetcher({
        transport: (url, req) => {
          const inner = squarespaceCommerceTransport(undefined, { token: KEY })(url, req);
          return n++ === 0
            ? inner
            : Promise.resolve({
                status: 429,
                headers: { "retry-after": "3600" },
                body: (async function* () {})() as never,
              });
        },
        timeoutMs: 5000,
      }),
      sleep: noWait,
    });
    const got = await collectPublished(limited);
    expect(got.docs.map((d) => d.id)).toEqual(["p-dawn", "p-tote"]);
    expect(got.partial).toMatchObject({ reason: "rate-limited", delivered: 2 });
    // The catalogue reports it the same way: what was read, marked partial, and stock not read.
    const catalogue = await limited.catalogue();
    expect(catalogue.partial?.reason).toBe("rate-limited");
    expect(catalogue.stock.state).toBe("unread");
  });
});

describe("the Squarespace commerce adapter: stock", () => {
  it("reads each variant as in stock (a quantity above 0 or unlimited) or out", async () => {
    const { stock } = await make().adapter.catalogue();
    expect(stock.state).toBe("read");
    if (stock.state !== "read") return;
    expect(Object.fromEntries(stock.byVariant)).toEqual({
      "v-dawn-a4": "in",
      "v-dawn-a3": "in",
      "v-tote": "out",
      "v-cards": "in",
      "v-zine": "in",
    });
  });

  it("a key with no Inventory permission still reads the products, and says why stock was not read", async () => {
    const got = await make({ api: { inventory: "forbidden" } }).adapter.catalogue();
    expect(got.products).toHaveLength(4);
    expect(got.stock).toMatchObject({ state: "unread" });
    expect(got.stock.state === "unread" && got.stock.reason).toMatch(
      /did not let the key read inventory \(HTTP 403\)/,
    );
  });
});
