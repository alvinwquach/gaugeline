import { describe, expect, it } from "vitest";
import { runConnectors } from "../run.js";
import {
  DEFAULT_SHOPIFY_API_VERSION,
  SHOPIFY_ENV_VARS,
  SHOPIFY_MAX_PAGES,
  createShopifyConnector,
  mapShopifyProduct,
  mapShopifyVariant,
  nextPageInfo,
  shopifyAvailability,
  shopifyHost,
  shopifyPrice,
  shopifyConnector,
} from "../shopify.js";
import { fake } from "./fake.js";
import type { Fetcher } from "../../fetcher.js";
import { lowerHeaders, recorded, serving, type Answer, type Seen } from "./serve.js";

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const TOKEN = ["shp", "at", "ridgeline0123456789abcdef"].join("");
const DOMAIN = "ridgeline-coaching.myshopify.com";
const ENV = { SHOPIFY_ACCESS_TOKEN: TOKEN, SHOPIFY_SHOP_DOMAIN: DOMAIN };
const API = `https://${DOMAIN}/admin/api/${DEFAULT_SHOPIFY_API_VERSION}`;

const noSleep = () => Promise.resolve();

const SCOPES_PATH = "/admin/oauth/access_scopes.json";
const READ_ONLY_SCOPES: Answer = {
  status: 200,
  body: { access_scopes: [{ handle: "read_products" }] },
};
const USD_SHOP: Answer = { status: 200, body: { shop: { currency: "USD" } } };

/** A fetcher for a healthy shop: the scopes and the currency answer, everything else goes to `rest`. */
function shopServing(
  rest: (url: URL, seen: Seen[]) => Answer,
  seen: Seen[] = [],
  answers: { scopes?: Answer; shop?: Answer } = {},
): Fetcher {
  return serving((url, s) => {
    if (url.pathname === SCOPES_PATH) return answers.scopes ?? READ_ONLY_SCOPES;
    if (url.pathname.endsWith("/shop.json")) return answers.shop ?? USD_SHOP;
    return rest(url, s);
  }, seen);
}
const path = (s: Seen) => new URL(s.url).pathname.replace(/^\/admin\/api\/[^/]+/, "");
const isProducts = (s: Seen) => path(s) === "/products.json";

describe("shopifyHost: unit", () => {
  it("accepts the store name or its myshopify.com address, in any case, with a scheme or a slash", () => {
    for (const input of [
      "ridgeline-coaching",
      "ridgeline-coaching.myshopify.com",
      "Ridgeline-Coaching.myshopify.com",
      "https://ridgeline-coaching.myshopify.com",
      "https://ridgeline-coaching.myshopify.com/",
      "  ridgeline-coaching.myshopify.com/admin  ",
    ])
      expect(shopifyHost(input), input).toBe(DOMAIN);
  });

  it("refuses anything that is not a myshopify.com store, because the token is sent there", () => {
    for (const bad of [
      "",
      "   ",
      "shop.example",
      "ridgeline.myshopify.com.evil.example",
      "evil.example/ridgeline.myshopify.com",
      "ridgeline.myshopify.com:8080",
      ["user", "ridgeline.myshopify.com"].join("@"),
      "-ridgeline.myshopify.com",
      "a b.myshopify.com",
      "myshopify.com",
      "http://127.0.0.1",
    ])
      expect(() => shopifyHost(bad), bad).toThrow(/myshopify\.com/);
  });
});

describe("shopifyPrice: unit", () => {
  it('"54.00" is 5400, "58.5" is 5850, "0.00" is 0 (free, not missing) and "" is null', () => {
    expect(shopifyPrice("54.00", "USD")).toBe(5400);
    expect(shopifyPrice("58.5", "USD")).toBe(5850);
    expect(shopifyPrice("0.00", "USD")).toBe(0);
    expect(shopifyPrice("0", "USD")).toBe(0);
    expect(shopifyPrice("", "USD")).toBeNull();
  });

  it("anything that is not a plain amount is null, never a guess", () => {
    for (const bad of [undefined, null, "free", "-1.00", "12.999", "1e3", {}, [], true])
      expect(shopifyPrice(bad, "USD"), String(bad)).toBeNull();
  });

  it("a currency with no minor unit keeps its whole number: 1500 yen is 1500, not 150000", () => {
    expect(shopifyPrice("1500.00", "JPY")).toBe(1500);
    expect(shopifyPrice("1500", "JPY")).toBe(1500);
    expect(shopifyPrice("1500.50", "JPY")).toBeNull();
  });
});

describe("shopifyAvailability: unit", () => {
  const table: Array<[string, Record<string, unknown>, boolean | null]> = [
    ["not tracked: always available", { inventory_management: null }, true],
    ["tracked with stock", { inventory_management: "shopify", inventory_quantity: 3 }, true],
    [
      "tracked, none left, deny",
      { inventory_management: "shopify", inventory_policy: "deny", inventory_quantity: 0 },
      false,
    ],
    [
      "tracked, oversold, continue selling",
      { inventory_management: "shopify", inventory_policy: "continue", inventory_quantity: -2 },
      true,
    ],
    [
      "tracked, negative, deny",
      { inventory_management: "shopify", inventory_policy: "deny", inventory_quantity: -1 },
      false,
    ],
    ["tracked, quantity not sent: unknown", { inventory_management: "shopify" }, null],
    [
      "tracked, quantity is text: unknown",
      { inventory_management: "shopify", inventory_quantity: "3" },
      null,
    ],
    [
      "tracked by a fulfilment service, none left, policy missing: unknown",
      { inventory_management: "gold-fulfilment", inventory_quantity: 0 },
      null,
    ],
    ["management not sent at all: unknown", { inventory_quantity: 4 }, null],
  ];
  for (const [name, raw, expected] of table)
    it(name, () => expect(shopifyAvailability(raw)).toBe(expected));
});

describe("mapping to catalogue items: unit", () => {
  it("a variant keeps id, sku, price, currency and availability, and nothing else", () => {
    const v = mapShopifyVariant(
      {
        id: 80013,
        title: "L",
        sku: "RL-HOOD-L",
        price: "58.50",
        barcode: "123",
        compare_at_price: "70.00",
        weight: 1,
        inventory_management: "shopify",
        inventory_policy: "deny",
        inventory_quantity: 0,
      },
      "USD",
    );
    expect(v).toEqual({
      id: "80013",
      sku: "RL-HOOD-L",
      price: 5850,
      currency: "USD",
      available: false,
    });
    expect(Object.keys(v).sort()).toEqual(["available", "currency", "id", "price", "sku"]);
  });

  it("a missing or empty sku is left out, not an empty string", () => {
    for (const sku of [undefined, "", "  ", null, 5]) {
      const v = mapShopifyVariant({ id: 1, price: "1.00", sku }, "USD");
      expect(Object.keys(v), String(sku)).not.toContain("sku");
    }
  });

  it("a variant with no id is refused", () => {
    expect(() => mapShopifyVariant({ price: "1.00" }, "USD")).toThrow(/no id/);
    expect(() => mapShopifyVariant("variant", "USD")).toThrow(/no id/);
  });

  it("a product is active only when its status says active; draft and archived are not", () => {
    const p = (status: unknown) =>
      mapShopifyProduct({ id: 1, title: "T", handle: "t", status, variants: [] }, "USD");
    expect(p("active").active).toBe(true);
    expect(p("draft").active).toBe(false);
    expect(p("archived").active).toBe(false);
    expect(p(undefined).active).toBe(false);
  });

  it("a product keeps source, id (as text), handle, name and its variants; a product with none has an empty list", () => {
    const item = mapShopifyProduct(
      {
        id: 7001,
        title: "Training hoodie",
        handle: "training-hoodie",
        status: "active",
        body_html: "<p>secret recipe</p>",
        vendor: "Ridgeline",
      },
      "USD",
    );
    expect(item).toEqual({
      source: "shopify",
      id: "7001",
      handle: "training-hoodie",
      name: "Training hoodie",
      active: true,
      variants: [],
    });
    expect(() => mapShopifyProduct({ title: "No id" }, "USD")).toThrow(/no id/);
  });
});

describe("nextPageInfo: unit", () => {
  it("reads the page_info of the rel=next link and ignores previous", () => {
    const link = `<${API}/products.json?limit=250&page_info=PREV1>; rel="previous", <${API}/products.json?limit=250&page_info=NEXT_2-x>; rel="next"`;
    expect(nextPageInfo(link)).toBe("NEXT_2-x");
  });

  it("is undefined with no header, no next link, or a next link without page_info", () => {
    expect(nextPageInfo(undefined)).toBeUndefined();
    expect(nextPageInfo("")).toBeUndefined();
    expect(nextPageInfo(`<${API}/products.json?page_info=P>; rel="previous"`)).toBeUndefined();
    expect(nextPageInfo(`<${API}/products.json?limit=250>; rel="next"`)).toBeUndefined();
  });
});

describe("configured: unit", () => {
  it("needs the token and the store; only the token is a key; the version is optional", () => {
    expect(shopifyConnector.id).toBe("shopify");
    expect(shopifyConnector.envVars).toEqual([...SHOPIFY_ENV_VARS]);
    expect(shopifyConnector.secretEnvVars).toEqual(["SHOPIFY_ACCESS_TOKEN"]);
    expect(shopifyConnector.optionalEnvVars).toEqual(["SHOPIFY_API_VERSION"]);
    expect(shopifyConnector.configured(ENV)).toBe(true);
    expect(shopifyConnector.configured({ SHOPIFY_ACCESS_TOKEN: TOKEN })).toBe(false);
    expect(shopifyConnector.configured({ SHOPIFY_SHOP_DOMAIN: DOMAIN })).toBe(false);
    expect(shopifyConnector.configured({ ...ENV, SHOPIFY_ACCESS_TOKEN: "" })).toBe(false);
  });
});

describe("integration: recorded responses", () => {
  it("the coach's shop: two list pages become four catalogue items, in order", async () => {
    const seen: Seen[] = [];
    const items = await shopifyConnector.read(ENV, recorded("shopify-shop", seen));
    expect(items.map((i) => [i.id, i.handle, i.name, i.active, i.variants.length])).toEqual([
      ["7001", "training-hoodie", "Training hoodie", true, 3],
      ["7002", "month-pass", "Month pass", true, 1],
      ["7003", "intro-session", "Intro session", true, 1],
      ["7004", "winter-challenge", "Winter challenge", false, 1],
    ]);
    expect(items[0]?.variants.map((v) => [v.sku, v.price, v.available])).toEqual([
      ["RL-HOOD-S", 5400, true],
      ["RL-HOOD-M", 5400, true],
      ["RL-HOOD-L", 5850, false],
    ]);
    expect(items.every((i) => i.source === "shopify")).toBe(true);
    // The shop's currency comes from the shop, not from the products.
    expect(items.flatMap((i) => i.variants.map((v) => v.currency))).toEqual(
      Array.from({ length: 6 }, () => "USD"),
    );
    // The token's scopes, the currency, then one request per list page.
    expect(seen.map((s) => new URL(s.url).pathname.replace(/\/api\/[^/]+/, ""))).toEqual([
      "/admin/oauth/access_scopes.json",
      "/admin/shop.json",
      "/admin/products.json",
      "/admin/products.json",
    ]);
    expect(new URL(seen[3]?.url ?? "").searchParams.get("page_info")).toBe(
      "eyJsYXN0X2lkIjo3MDAyLCJsYXN0X3ZhbHVlIjoiMTcifQ",
    );
  });

  it("a price of zero stays 0, and a product that is archived is inactive, not missing", async () => {
    const items = await shopifyConnector.read(ENV, recorded("shopify-shop"));
    const intro = items.find((i) => i.handle === "intro-session");
    expect(intro?.variants[0]?.price).toBe(0);
    expect(intro?.variants[0]?.available).toBe(true); // oversold, but the shop keeps selling
    const pass = items.find((i) => i.handle === "month-pass");
    expect(pass?.variants[0]?.available).toBe(true); // not tracked
    expect(items.find((i) => i.handle === "winter-challenge")?.active).toBe(false);
  });

  it("a product with forty variants comes back whole", async () => {
    const items = await shopifyConnector.read(ENV, recorded("shopify-large"));
    expect(items).toHaveLength(1);
    const kit = items[0];
    expect(kit?.variants).toHaveLength(40);
    expect(kit?.variants.map((v) => v.sku)).toEqual(
      Array.from({ length: 40 }, (_, i) => `RL-KIT-${String(i + 1).padStart(2, "0")}`),
    );
    expect(kit?.variants[0]?.price).toBe(2000);
    expect(kit?.variants[39]?.price).toBe(3950);
    expect(new Set(kit?.variants.map((v) => v.id)).size).toBe(40);
  });

  it("every request is a GET; the token is in a header, never in an address; the host is the store's", async () => {
    const seen: Seen[] = [];
    await shopifyConnector.read(ENV, recorded("shopify-shop", seen));
    expect(seen).toHaveLength(4);
    for (const s of seen) {
      expect(s.method).toBe("GET");
      expect(lowerHeaders(s.headers)["x-shopify-access-token"]).toBe(TOKEN);
      expect(s.url).not.toContain(TOKEN);
      expect(new URL(s.url).host).toBe(DOMAIN);
      expect(new URL(s.url).pathname).toMatch(
        /^\/admin\/(?:api\/2025-07\/(?:shop|products)\.json|oauth\/access_scopes\.json)$/,
      );
    }
  });

  it("the only questions asked are the token's scopes, the shop's currency and the product list: no mutation, no other resource", async () => {
    const seen: Seen[] = [];
    await shopifyConnector.read(ENV, recorded("shopify-large", seen));
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname.split("/").pop()}`)).toEqual([
      "GET access_scopes.json",
      "GET shop.json",
      "GET products.json",
    ]);
    for (const s of seen) {
      const u = new URL(s.url);
      expect(u.pathname).not.toMatch(/graphql/i);
      expect(u.href).not.toMatch(/mutation|subscription/i);
    }
  });

  it("SHOPIFY_API_VERSION chooses the version in the address", async () => {
    const seen: Seen[] = [];
    await shopifyConnector.read(
      { ...ENV, SHOPIFY_API_VERSION: "2026-01" },
      shopServing(() => ({ status: 200, body: { products: [] } }), seen),
    );
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual([
      "/admin/oauth/access_scopes.json",
      "/admin/api/2026-01/shop.json",
      "/admin/api/2026-01/products.json",
    ]);
  });

  it("a version that is not a quarterly release is refused before anything is asked", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [shopifyConnector],
      { ...ENV, SHOPIFY_API_VERSION: "latest" },
      serving(() => ({ status: 200 }), seen),
    );
    expect(seen).toHaveLength(0);
    expect(run.notices[0]?.kind).toBe("unreachable");
    expect(run.notices[0]?.message).toMatch(/SHOPIFY_API_VERSION/);
  });

  it("a store address that is not myshopify.com is refused before anything is asked, and the token goes nowhere", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [shopifyConnector],
      { ...ENV, SHOPIFY_SHOP_DOMAIN: "shop.example" },
      serving(() => ({ status: 200 }), seen),
    );
    expect(seen).toHaveLength(0);
    expect(run.notices[0]?.message).toMatch(/SHOPIFY_SHOP_DOMAIN/);
    expect(JSON.stringify(run)).not.toContain(TOKEN);
  });
});

describe("errors: integration", () => {
  it("401: one request, one notice that names the token, and the other systems are still returned", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [
        fake("sanity", ["SANITY_PROJECT_ID"], async () => [{ id: "tasting-box" }]),
        shopifyConnector,
      ],
      { ...ENV, SANITY_PROJECT_ID: "ember" },
      serving(() => ({ status: 401, body: { errors: `[API] Invalid API key: ${TOKEN}` } }), seen),
    );
    expect(run.data.get("sanity")).toHaveLength(1);
    expect(run.data.has("shopify")).toBe(false);
    expect(run.notices).toHaveLength(1);
    const n = run.notices[0];
    expect(n?.kind).toBe("refused");
    expect(n?.message).toMatch(/SHOPIFY_ACCESS_TOKEN/);
    expect(n?.message).toMatch(/401/);
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    expect(seen).toHaveLength(1);
  });

  it("403 on the products: the notice says the token lacks read_products and nothing more is needed", async () => {
    const run = await runConnectors(
      [shopifyConnector],
      ENV,
      shopServing(() => ({
        status: 403,
        body: { errors: "This action requires merchant approval for read_products scope." },
      })),
    );
    const n = run.notices[0];
    expect(n?.kind).toBe("refused");
    expect(n?.message).toMatch(/read_products/);
    expect(n?.message).toMatch(/403/);
  });

  it("404 on the shop: the notice says there is no store at that address", async () => {
    const run = await runConnectors(
      [shopifyConnector],
      ENV,
      serving(() => ({ status: 404 })),
    );
    expect(run.notices[0]?.kind).toBe("unreachable");
    expect(run.notices[0]?.message).toContain(DOMAIN);
    expect(run.notices[0]?.message).toMatch(/SHOPIFY_SHOP_DOMAIN/);
  });

  it("a shop currency that cannot be read leaves the currency empty and says so; the products are still read", async () => {
    const run = await runConnectors(
      [shopifyConnector],
      ENV,
      shopServing(
        () => ({
          status: 200,
          body: {
            products: [
              {
                id: 1,
                title: "Tee",
                handle: "tee",
                status: "active",
                variants: [{ id: 2, price: "10.00" }],
              },
            ],
          },
        }),
        [],
        { shop: { status: 500 } },
      ),
    );
    const items = run.data.get("shopify") as Array<{ variants: Array<{ currency: string }> }>;
    expect(items[0]?.variants[0]?.currency).toBe("");
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]?.kind).toBe("advice");
    expect(run.notices[0]?.message).toMatch(/currency/);
  });

  it("429 with a decimal Retry-After (Shopify's form): waits it out once, then succeeds", async () => {
    const seen: Seen[] = [];
    const waits: number[] = [];
    let limited = false;
    const fetcher = shopServing(() => {
      if (!limited) {
        limited = true;
        return { status: 429, headers: { "retry-after": "2.0" } };
      }
      return { status: 200, body: { products: [] } };
    }, seen);
    const connector = createShopifyConnector({
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(await connector.read(ENV, fetcher)).toEqual([]);
    expect(waits).toEqual([2000]);
    expect(seen.filter(isProducts)).toHaveLength(2);
  });

  it("a second 429 gives up with a notice that says when to try again, in plain seconds", async () => {
    const run = await runConnectors(
      [createShopifyConnector({ sleep: noSleep })],
      ENV,
      shopServing(() => ({ status: 429, headers: { "retry-after": "1.5" } })),
    );
    const n = run.notices[0];
    expect(n?.kind).toBe("unreachable");
    expect(n?.message).toMatch(/slow down/);
    expect(n?.message).toContain("in 2 seconds");
  });

  it("a 429 with no Retry-After gives up at once", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [createShopifyConnector({ sleep: noSleep })],
      ENV,
      shopServing(() => ({ status: 429 }), seen),
    );
    expect(run.notices[0]?.kind).toBe("unreachable");
    expect(seen.filter(isProducts)).toHaveLength(1);
  });

  it("an answer that is not JSON, or not a list of products, is unreachable with the token blanked", async () => {
    for (const body of ["<html>maintenance</html>", { nothing: true }, "{"]) {
      const run = await runConnectors(
        [shopifyConnector],
        ENV,
        shopServing(() => ({ status: 200, body })),
      );
      expect(run.notices[0]?.kind, JSON.stringify(body)).toBe("unreachable");
      expect(JSON.stringify(run)).not.toContain(TOKEN);
    }
  });
});

describe("paging: edge cases", () => {
  const product = (id: number) => ({
    id,
    title: `Item ${id}`,
    handle: `item-${id}`,
    status: "active",
    variants: [{ id: id * 10, price: "5.00", sku: `S${id}` }],
  });
  const linkTo = (info: string) => ({
    link: `<${API}/products.json?limit=250&page_info=${info}>; rel="next"`,
  });

  it("an empty store is an empty list, not a failure", async () => {
    const items = await shopifyConnector.read(
      ENV,
      shopServing(() => ({ status: 200, body: { products: [] } })),
    );
    expect(items).toEqual([]);
  });

  it("the same page_info twice stops the read with a note instead of looping", async () => {
    const notes: string[] = [];
    const seen: Seen[] = [];
    const items = await shopifyConnector.read(
      ENV,
      shopServing(
        () => ({ status: 200, body: { products: [product(1)] }, headers: linkTo("SAME") }),
        seen,
      ),
      (m) => notes.push(m),
    );
    expect(items.map((i) => i.id)).toEqual(["1"]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/same page/);
    expect(seen.filter(isProducts)).toHaveLength(2);
  });

  it("a product repeated across pages is kept once", async () => {
    const items = await shopifyConnector.read(
      ENV,
      shopServing((url) =>
        url.searchParams.has("page_info")
          ? { status: 200, body: { products: [product(2), product(3)] } }
          : { status: 200, body: { products: [product(1), product(2)] }, headers: linkTo("P2") },
      ),
    );
    expect(items.map((i) => i.id)).toEqual(["1", "2", "3"]);
  });

  it("past the page cap the run keeps what it read and one note says so", async () => {
    const notes: string[] = [];
    const seen: Seen[] = [];
    let n = 0;
    const items = await shopifyConnector.read(
      ENV,
      shopServing(() => {
        n++;
        return { status: 200, body: { products: [product(n)] }, headers: linkTo(`P${n + 1}`) };
      }, seen),
      (m) => notes.push(m),
    );
    expect(seen.filter(isProducts)).toHaveLength(SHOPIFY_MAX_PAGES);
    expect(items).toHaveLength(SHOPIFY_MAX_PAGES);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(new RegExp(`${SHOPIFY_MAX_PAGES} pages`));
  });

  it("a next link to another host is never followed: only its page_info is used, on the store's own address", async () => {
    const seen: Seen[] = [];
    await shopifyConnector.read(
      ENV,
      shopServing(
        (url) =>
          url.searchParams.has("page_info")
            ? { status: 200, body: { products: [] } }
            : {
                status: 200,
                body: { products: [product(1)] },
                headers: {
                  link: '<https://evil.example/steal.json?limit=250&page_info=ZZ>; rel="next"',
                },
              },
        seen,
      ),
    );
    expect(seen.filter(isProducts)).toHaveLength(2);
    for (const s of seen) {
      expect(new URL(s.url).host).toBe(DOMAIN);
      expect(lowerHeaders(s.headers)["x-shopify-access-token"]).toBe(TOKEN);
    }
  });
});

describe("advice: the token's scopes", () => {
  const scopes = (...handles: string[]): Answer => ({
    status: 200,
    body: { access_scopes: handles.map((handle) => ({ handle })) },
  });
  const empty = () => ({ status: 200, body: { products: [] } });

  it("a token with read_products only gets no advice, from one request for the scopes", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors([shopifyConnector], ENV, shopServing(empty, seen));
    expect(run.notices).toEqual([]);
    expect(seen.filter((s) => new URL(s.url).pathname === SCOPES_PATH)).toHaveLength(1);
  });

  it("a token that can also write is named in one piece of advice, and the token is not", async () => {
    const run = await runConnectors(
      [shopifyConnector],
      ENV,
      shopServing(empty, [], { scopes: scopes("read_products", "write_products", "read_orders") }),
    );
    expect(run.data.get("shopify")).toEqual([]);
    expect(run.notices).toHaveLength(1);
    const n = run.notices[0];
    expect(n?.kind).toBe("advice");
    expect(n?.message).toContain("read_orders, write_products");
    expect(n?.message).toMatch(/only needs read_products/);
    expect(JSON.stringify(run)).not.toContain(TOKEN);
  });

  it("when the scopes cannot be read there is no advice and the products are still returned", async () => {
    for (const status of [403, 404, 500]) {
      const run = await runConnectors(
        [shopifyConnector],
        ENV,
        shopServing(empty, [], { scopes: { status } }),
      );
      expect(run.notices, String(status)).toEqual([]);
      expect(run.data.get("shopify")).toEqual([]);
    }
  });
});

describe("keys and the runner: promise tests", () => {
  it("no variable set: zero requests and a not-configured notice, never a pass", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [shopifyConnector],
      {},
      serving(() => ({ status: 200 }), seen),
    );
    expect(seen).toHaveLength(0);
    expect(run.data.has("shopify")).toBe(false);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]?.kind).toBe("not-configured");
    expect(run.notices[0]?.message).toContain("SHOPIFY_ACCESS_TOKEN");
    expect(run.notices[0]?.message).toContain("SHOPIFY_SHOP_DOMAIN");
  });

  it("the token set without the store: not configured, and the notice names the missing variable", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [shopifyConnector],
      { SHOPIFY_ACCESS_TOKEN: TOKEN },
      serving(() => ({ status: 200 }), seen),
    );
    expect(seen).toHaveLength(0);
    expect(run.notices[0]?.kind).toBe("not-configured");
    expect(run.notices[0]?.message).toContain("SHOPIFY_SHOP_DOMAIN");
    expect(run.notices[0]?.message).not.toContain("SHOPIFY_ACCESS_TOKEN");
    expect(JSON.stringify(run)).not.toContain(TOKEN);
  });

  it("an error body that echoes the token, in a status line or a payload, reaches no notice", async () => {
    const answers: Answer[] = [
      { status: 500, body: `boom ${TOKEN}` },
      { status: 200, body: `{"products": "${TOKEN}"}` },
    ];
    for (const a of answers) {
      const run = await runConnectors(
        [shopifyConnector],
        ENV,
        shopServing(() => a),
      );
      expect(JSON.stringify(run)).not.toContain(TOKEN);
    }
  });
});
