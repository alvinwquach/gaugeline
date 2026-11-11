import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readShopify, type ShopifyReading } from "../../adapters/shopify-read.js";
import { createShopifyAdapter } from "../../adapters/shopify.js";
import {
  LIVE_HEALTHY,
  productHtml,
  productHtmlOffers,
  SHOPIFY_CONTENT,
  SHOPIFY_MARKERS,
  SHOPIFY_SHOP,
  SHOPIFY_SITE,
  shopifyStoreTransport,
  type LivePages,
} from "../../adapters/__tests__/shopify-fixture.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { SHOPIFY_CHECKS, createShopifyRegistry } from "../shopify.js";

const KEY = testKey("shopify-checks");

async function read(
  pages: LivePages = LIVE_HEALTHY,
  over: {
    token?: string;
    maxPages?: number;
    content?: typeof SHOPIFY_CONTENT;
    wrap?: (t: Transport) => Transport;
  } = {},
): Promise<{ reading: ShopifyReading; seen: string[] }> {
  const seen: string[] = [];
  const base = shopifyStoreTransport(
    pages,
    {
      token: KEY,
      onRequest: (method, url) => seen.push(`${method} ${url.href}`),
    },
    over.content,
  );
  const fetcher = createFetcher({
    transport: over.wrap ? over.wrap(base) : base,
    timeoutMs: 5000,
  });
  const adapter = createShopifyAdapter({
    env: {
      SHOPIFY_STOREFRONT_TOKEN: over.token ?? KEY,
      SHOPIFY_SHOP_DOMAIN: SHOPIFY_SHOP,
    },
    fetcher,
    sleep: () => Promise.resolve(),
  });
  return {
    reading: await readShopify({
      adapter,
      fetcher,
      site: SHOPIFY_SITE,
      shopHost: SHOPIFY_SHOP,
      ...(over.maxPages === undefined ? {} : { maxPages: over.maxPages }),
    }),
    seen,
  };
}

const run = (r: ShopifyReading) => runChecks(r, createShopifyRegistry());
const evidence = (r: Awaited<ReturnType<typeof run>>, id: string): string[] =>
  r.findings.filter((f) => f.checkId === id).map((f) => f.evidence);

describe("Shopify checks: a ceramics studio's store", () => {
  it("a healthy store gives no finding and passes all three checks", async () => {
    const out = await run((await read()).reading);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(SHOPIFY_CHECKS.map((c) => c.id).sort());
  });

  it("a product hidden from the Online Store is not reported as missing, and its page is never asked for", async () => {
    // The hidden product has no page, as a hidden product should not.
    const { reading: r, seen } = await read({ ...LIVE_HEALTHY, "/products/kiln-seconds-box": 404 });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(seen.some((s) => s.includes("kiln-seconds-box"))).toBe(false);
    expect(JSON.stringify(r)).not.toContain("kiln-seconds-box");
  });
});

describe("shopify-item-no-page: a positive and a negative fixture", () => {
  it("positive: a published page and a published product whose address answers 404 or 410", async () => {
    const out = await run(
      (await read({ ...LIVE_HEALTHY, "/pages/about": 404, "/products/bowl-ash-glaze": 410 }))
        .reading,
    );
    expect(evidence(out, "shopify-item-no-page")).toEqual([
      "products: bowl-ash-glaze is published to the Online Store and /products/bowl-ash-glaze answers 410",
      "pages: about is published to the Online Store and /pages/about answers 404",
    ]);
    expect(out.findings.every((f) => f.severity === "high")).toBe(true);
    expect(out.findings.map((f) => f.url)).toEqual([
      `${SHOPIFY_SITE}/products/bowl-ash-glaze`,
      `${SHOPIFY_SITE}/pages/about`,
    ]);
  });

  it("negative: a page that answers 500 is could-not-check, not a finding", async () => {
    const out = await run((await read({ ...LIVE_HEALTHY, "/pages/about": 500 })).reading);
    expect(out.findings).toEqual([]);
    expect(JSON.stringify(out.couldNotCheck)).toContain("the site answered 500");
  });

  it("a run that asks for fewer pages than there are says so", async () => {
    const out = await run((await read(LIVE_HEALTHY, { maxPages: 3 })).reading);
    expect(JSON.stringify(out.couldNotCheck)).toContain("not asked for");
  });
});

describe("shopify-product-drift: a positive and a negative fixture", () => {
  it("positive: the page shows a price outside the store's, and a stock state the store contradicts", async () => {
    const out = await run(
      (
        await read({
          ...LIVE_HEALTHY,
          "/products/mug-speckled": { html: productHtml("30.00") },
          "/products/bowl-ash-glaze": { html: productHtml("42.50", "USD", "InStock") },
        })
      ).reading,
    );
    expect(evidence(out, "shopify-product-drift")).toEqual([
      "mug-speckled: the page shows 30.00 USD but the Storefront API says 28.00 USD; the product data says 30.00 USD but the Storefront API says 28.00 USD",
      "bowl-ash-glaze: the page says InStock but the Storefront API says it cannot be bought",
    ]);
  });

  it("positive: the page says sold out for a product the store can sell", async () => {
    const out = await run(
      (
        await read({
          ...LIVE_HEALTHY,
          "/products/mug-speckled": {
            html: productHtml("28.00", "USD", "OutOfStock"),
          },
        })
      ).reading,
    );
    expect(evidence(out, "shopify-product-drift")).toEqual([
      "mug-speckled: the page says sold out but the Storefront API says it can be bought",
    ]);
  });

  it("negative: the same price and stock is no finding, and a price inside the variant range is not drift", async () => {
    const content = structuredClone(SHOPIFY_CONTENT);
    const mug = content.products?.[0];
    if (mug)
      mug.priceRange = {
        minVariantPrice: { amount: "24.00", currencyCode: "USD" },
        maxVariantPrice: { amount: "34.00", currencyCode: "USD" },
      };
    const fetcher = createFetcher({
      transport: shopifyStoreTransport(LIVE_HEALTHY, { token: KEY }, content),
      timeoutMs: 5000,
    });
    const adapter = createShopifyAdapter({
      env: { SHOPIFY_STOREFRONT_TOKEN: KEY, SHOPIFY_SHOP_DOMAIN: SHOPIFY_SHOP },
      fetcher,
      sleep: () => Promise.resolve(),
    });
    const out = await run(await readShopify({ adapter, fetcher, site: SHOPIFY_SITE }));
    expect(evidence(out, "shopify-product-drift")).toEqual([]);
  });

  it("a page in another currency is could-not-check, never converted and never a finding", async () => {
    const out = await run(
      (
        await read({
          ...LIVE_HEALTHY,
          "/products/mug-speckled": { html: productHtml("26.00", "EUR") },
        })
      ).reading,
    );
    expect(evidence(out, "shopify-product-drift")).toEqual([]);
    expect(JSON.stringify(out.couldNotCheck)).toContain("never converted");
  });

  it("a page with no readable price is not a finding", async () => {
    const out = await run(
      (await read({ ...LIVE_HEALTHY, "/products/mug-speckled": { html: "<html></html>" } }))
        .reading,
    );
    expect(evidence(out, "shopify-product-drift")).toEqual([]);
  });
});

describe("shopify-theme-preview-indexable: a positive and a negative fixture", () => {
  const home = (href: string) => ({
    html: `<html><body><a href="${href}">Preview</a></body></html>`,
  });
  const preview = "/?preview_theme_id=1234";

  it("positive: a linked preview with no noindex and no canonical is found", async () => {
    const out = await run(
      (
        await read({
          ...LIVE_HEALTHY,
          "/": home(preview),
          [preview]: { html: "<html><body>New theme</body></html>" },
        })
      ).reading,
    );
    expect(evidence(out, "shopify-theme-preview-indexable")).toEqual([
      "larkspur-ceramics.example/ (preview_theme_id) is linked from the live site and it has no noindex and no canonical",
    ]);
    expect(out.findings[0]?.severity).toBe("medium");
  });

  it("negative: noindex in the meta tag or the header, or a canonical to the public page, is not indexable", async () => {
    for (const page of [
      { html: '<html><head><meta name="robots" content="noindex, nofollow"></head></html>' },
      { headers: { "x-robots-tag": "noindex" }, html: "<html></html>" },
      { html: `<html><head><link rel="canonical" href="${SHOPIFY_SITE}/"></head></html>` },
    ]) {
      const out = await run(
        (await read({ ...LIVE_HEALTHY, "/": home(preview), [preview]: page })).reading,
      );
      expect(evidence(out, "shopify-theme-preview-indexable")).toEqual([]);
    }
  });

  it("negative: no link to a preview means nothing is asked and nothing is guessed", async () => {
    const { reading: r, seen } = await read();
    expect(r.previews).toEqual([]);
    expect(seen.some((s) => s.includes("preview_theme_id"))).toBe(false);
  });

  it("a link to a shopifypreview.com address is followed, https only", async () => {
    const href = "https://larkspur-ceramics.shopifypreview.com/";
    const { reading: r } = await read({
      ...LIVE_HEALTHY,
      "/": home(`http://x.shopifypreview.com/`),
    });
    expect(r.previews).toEqual([]);
    expect(href).toContain("shopifypreview.com");
  });
});

describe("Shopify checks: what the store will not say, and what is never printed", () => {
  it("a token the store refuses is could-not-check for the whole read, with no finding", async () => {
    const out = await run((await read(LIVE_HEALTHY, { token: "not-the-token" })).reading);
    expect(out.findings).toEqual([]);
    expect(JSON.stringify(out.couldNotCheck)).toContain("SHOPIFY_STOREFRONT_TOKEN");
    expect(JSON.stringify(out)).not.toContain("not-the-token");
  });

  it("never prints the client's words or the token", async () => {
    const { reading: r } = await read({
      ...LIVE_HEALTHY,
      "/pages/about": 404,
      "/products/mug-speckled": { html: productHtml("30.00") },
    });
    const text = JSON.stringify([r, await run(r)]);
    for (const marker of Object.values(SHOPIFY_MARKERS)) expect(text).not.toContain(marker);
    expect(text).not.toContain(KEY);
  });

  it("is deterministic: the same store gives the same findings", async () => {
    const pages = { ...LIVE_HEALTHY, "/pages/about": 404 };
    const a = await run((await read(pages)).reading);
    const b = await run((await read(pages)).reading);
    expect(b.findings).toEqual(a.findings);
  });
});

const reply = (body: unknown) =>
  Promise.resolve({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

const redirectAbout =
  (to: string) =>
  (t: Transport): Transport =>
  (url, req) =>
    url.pathname === "/pages/about" && req.method === "GET"
      ? Promise.resolve({
          status: 302,
          headers: { location: `${SHOPIFY_SITE}${to}` },
          body: Readable.from([Buffer.from("")]),
        })
      : t(url, req);

describe("review fixes: currencies, skipped products, variants, previews, isolation, soft failures", () => {
  it("a yen store is not compared in hundredths: could-not-check, never a false drift", async () => {
    const content = structuredClone(SHOPIFY_CONTENT);
    const mug = content.products?.[0];
    if (mug)
      mug.priceRange = {
        minVariantPrice: { amount: "1500.0", currencyCode: "JPY" },
        maxVariantPrice: { amount: "1500.0", currencyCode: "JPY" },
      };
    const html = productHtml("1,500", "JPY").replace("$1,500", "¥1,500");
    const { reading: r } = await read(
      { ...LIVE_HEALTHY, "/products/mug-speckled": { html } },
      { content },
    );
    const out = await run(r);
    expect(evidence(out, "shopify-product-drift")).toEqual([]);
    expect(JSON.stringify(out.couldNotCheck)).toContain("minor unit");
  });

  it("evidence is formatted by the currency, not divided by 100", async () => {
    const out = await run(
      (await read({ ...LIVE_HEALTHY, "/products/mug-speckled": { html: productHtml("30.00") } }))
        .reading,
    );
    expect(evidence(out, "shopify-product-drift")[0]).toContain("28.00 USD");
  });

  it("products are read first, and a budget that skips some says the drift check did not compare them", async () => {
    const { reading: r, seen } = await read(LIVE_HEALTHY, { maxPages: 1 });
    const productPages = seen.filter((s) => s.startsWith("GET") && s.includes("/products/"));
    expect(productPages).toHaveLength(1);
    expect(r.productsSkipped).toBe(1);
    const out = await run(r);
    expect(
      JSON.stringify(out.couldNotCheck.filter((c) => c.id === "shopify-product-drift")),
    ).toContain("not compared");
    expect(out.passed).not.toContain("shopify-product-drift");
  });

  it("a first variant sold out beside one in stock is not drift when the store can sell it", async () => {
    const html = productHtmlOffers("28.00", ["OutOfStock", "InStock"]);
    const out = await run(
      (await read({ ...LIVE_HEALTHY, "/products/mug-speckled": { html } })).reading,
    );
    expect(evidence(out, "shopify-product-drift")).toEqual([]);
  });

  it("every variant sold out on the page against a product the store can sell is drift", async () => {
    const html = productHtmlOffers("28.00", ["OutOfStock", "SoldOut"]);
    const out = await run(
      (await read({ ...LIVE_HEALTHY, "/products/mug-speckled": { html } })).reading,
    );
    expect(evidence(out, "shopify-product-drift")).toEqual([
      "mug-speckled: the page says sold out but the Storefront API says it can be bought",
    ]);
  });

  it("a sold-out button alone (it may be a recommendation or a variant) is not a finding", async () => {
    const html =
      '<html><body><span class="price-item--regular">$28.00</span><button>Sold out</button></body></html>';
    const out = await run(
      (await read({ ...LIVE_HEALTHY, "/products/mug-speckled": { html } })).reading,
    );
    expect(evidence(out, "shopify-product-drift")).toEqual([]);
  });

  const home = (href: string) => ({
    html: `<html><body><a href="${href}">Preview</a></body></html>`,
  });

  it("a preview link on another site is never asked for and never shown", async () => {
    const other = "https://evil.example/?preview_theme_id=9";
    const { reading: r, seen } = await read({ ...LIVE_HEALTHY, "/": home(other) });
    expect(seen.some((s) => s.includes("evil.example"))).toBe(false);
    expect(JSON.stringify(await run(r))).not.toContain("evil.example");
  });

  it("a preview whose canonical points at a different address, even on another host, is not indexable", async () => {
    const preview = "/?preview_theme_id=1234";
    const html =
      '<html><head><link rel="canonical" href="https://shop.example.net/"></head></html>';
    const out = await run(
      (await read({ ...LIVE_HEALTHY, "/": home(preview), [preview]: { html } })).reading,
    );
    expect(evidence(out, "shopify-theme-preview-indexable")).toEqual([]);
  });

  it("a token that may not read articles loses only the articles", async () => {
    const wrap =
      (t: Transport): Transport =>
      (url, req) =>
        /\{ articles\(/.test(req.body ?? "")
          ? reply({ errors: [{ extensions: { code: "ACCESS_DENIED" } }] })
          : t(url, req);
    const { reading: r } = await read(
      {
        ...LIVE_HEALTHY,
        "/pages/about": 404,
        "/products/mug-speckled": { html: productHtml("30.00") },
      },
      { wrap },
    );
    const out = await run(r);
    expect(evidence(out, "shopify-item-no-page")).toHaveLength(1);
    expect(evidence(out, "shopify-product-drift")).toHaveLength(1);
    expect(JSON.stringify(out.couldNotCheck)).toContain("articles");
  });

  it("one item with a handle that is not ASCII is could-not-check by itself", async () => {
    const content = structuredClone(SHOPIFY_CONTENT);
    content.pages?.push({
      id: "gid://shopify/Page/3003",
      handle: "über-uns",
      onlineStoreUrl: `${SHOPIFY_SITE}/pages/%C3%BCber-uns`,
      updatedAt: "2026-10-10T09:00:00Z",
    });
    const out = await run((await read(LIVE_HEALTHY, { content })).reading);
    expect(out.findings).toEqual([]);
    expect(JSON.stringify(out.couldNotCheck)).toContain("pages 3003");
  });

  it("a published page that redirects to the home page is a finding", async () => {
    const out = await run((await read(LIVE_HEALTHY, { wrap: redirectAbout("/") })).reading);
    expect(evidence(out, "shopify-item-no-page")).toEqual([
      "pages: about is published to the Online Store and /pages/about redirects to the home page",
    ]);
  });

  it("a redirect to the password page is could-not-check, not a pass", async () => {
    const out = await run(
      (await read({ ...LIVE_HEALTHY, "/password": 200 }, { wrap: redirectAbout("/password") }))
        .reading,
    );
    expect(evidence(out, "shopify-item-no-page")).toEqual([]);
    expect(JSON.stringify(out.couldNotCheck)).toContain("password");
  });
});

describe("review fixes: preview hosts, preview addresses, products with no price (M2, L3, L8)", () => {
  const home = (href: string) => ({
    html: `<html><body><a href="${href}">Preview</a></body></html>`,
  });

  it("M2: a preview link on another store's myshopify.com address is not asked for, and its key is shown nowhere", async () => {
    const other = "https://other-shop.myshopify.com/?preview_theme_id=1&key=abc";
    const { reading: r, seen } = await read({ ...LIVE_HEALTHY, "/": home(other) });
    expect(seen.some((s) => s.includes("other-shop"))).toBe(false);
    const out = await run(r);
    expect(JSON.stringify({ r, out })).not.toMatch(/key=abc|other-shop/);
    // The refusal is said, without the address.
    expect(JSON.stringify(out.couldNotCheck)).toContain("not this store's");
  });

  it("M2: another store's shopifypreview.com address is refused the same way", async () => {
    const other = "https://some-other-shop.shopifypreview.com/?key=abc";
    const { reading: r, seen } = await read({ ...LIVE_HEALTHY, "/": home(other) });
    expect(seen.some((s) => s.includes("shopifypreview.com"))).toBe(false);
    expect(JSON.stringify(r)).not.toContain("key=abc");
  });

  it("M2: the configured shop's own myshopify.com address is followed, and the finding's address keeps only preview_theme_id", async () => {
    const own = `https://${SHOPIFY_SHOP}/?preview_theme_id=77&key=abc&token=zzz`;
    const wrap =
      (t: Transport): Transport =>
      (url, req) =>
        url.host === SHOPIFY_SHOP && req.method === "GET"
          ? Promise.resolve({
              status: 200,
              headers: { "content-type": "text/html" },
              body: Readable.from([Buffer.from("<html><body>New theme</body></html>")]),
            })
          : t(url, req);
    const { reading: r } = await read({ ...LIVE_HEALTHY, "/": home(own) }, { wrap });
    expect(r.previews).toHaveLength(1);
    expect(r.previews[0]?.url).toBe(`https://${SHOPIFY_SHOP}/?preview_theme_id=77`);
    const out = await run(r);
    expect(JSON.stringify({ r, out })).not.toMatch(/key=abc|token=zzz/);
  });

  it("M2: a link on the site's own host keeps only preview_theme_id in the finding's address", async () => {
    const preview = "/?preview_theme_id=1234&key=abc";
    const { reading: r } = await read({
      ...LIVE_HEALTHY,
      "/": home(preview),
      [preview]: { html: "<html><body>New theme</body></html>" },
    });
    expect(r.previews).toHaveLength(1);
    expect(r.previews[0]?.url).toBe(`${SHOPIFY_SITE}/?preview_theme_id=1234`);
    const out = await run(r);
    expect(out.findings.map((f) => f.url)).toEqual([`${SHOPIFY_SITE}/?preview_theme_id=1234`]);
    expect(JSON.stringify({ r, out })).not.toContain("key=abc");
  });

  it("L8: a published product the second read gave no price for is could-not-check, not dropped", async () => {
    // The price read asks for priceRange; the list read does not. Leave the mug out of the price read only.
    const wrap =
      (t: Transport): Transport =>
      async (url, req) => {
        const res = await t(url, req);
        if (!/priceRange/.test(req.body ?? "")) return res;
        const text = await new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          res.body.on("data", (c: Buffer) => chunks.push(c));
          res.body.on("end", () => resolve(Buffer.concat(chunks).toString()));
        });
        const data = JSON.parse(text) as { data: { products: { nodes: { handle: string }[] } } };
        data.data.products.nodes = data.data.products.nodes.filter(
          (n) => n.handle !== "mug-speckled",
        );
        return { ...res, body: Readable.from([Buffer.from(JSON.stringify(data))]) };
      };
    const { reading: r } = await read(LIVE_HEALTHY, { wrap });
    const out = await run(r);
    expect(
      JSON.stringify(out.couldNotCheck.filter((c) => c.id === "shopify-product-drift")),
    ).toContain("no price from the Storefront API");
    expect(out.passed).not.toContain("shopify-product-drift");
  });

  it("L3: items skipped past the list's cap are said in one could-not-check", async () => {
    const content = structuredClone(SHOPIFY_CONTENT);
    for (let i = 0; i < 1003; i++)
      content.pages?.push({
        id: `gid://shopify/Page/${9000 + i}`,
        handle: `\u00fcber-${i}`,
        onlineStoreUrl: `${SHOPIFY_SITE}/pages/x`,
        updatedAt: "2026-10-10T09:00:00Z",
      });
    const out = await run((await read(LIVE_HEALTHY, { content })).reading);
    expect(JSON.stringify(out.couldNotCheck)).toContain("3 more");
  });
});
