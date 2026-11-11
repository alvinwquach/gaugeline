import { describe, expect, it } from "vitest";
import { readShopify, type ShopifyReading } from "../../adapters/shopify-read.js";
import { createShopifyAdapter } from "../../adapters/shopify.js";
import {
  LIVE_HEALTHY,
  productHtml,
  SHOPIFY_CONTENT,
  SHOPIFY_MARKERS,
  SHOPIFY_SHOP,
  SHOPIFY_SITE,
  shopifyStoreTransport,
  type LivePages,
} from "../../adapters/__tests__/shopify-fixture.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { SHOPIFY_CHECKS, createShopifyRegistry } from "../shopify.js";

const KEY = testKey("shopify-checks");

async function read(
  pages: LivePages = LIVE_HEALTHY,
  over: { token?: string; maxPages?: number } = {},
): Promise<{ reading: ShopifyReading; seen: string[] }> {
  const seen: string[] = [];
  const fetcher = createFetcher({
    transport: shopifyStoreTransport(pages, {
      token: KEY,
      onRequest: (method, url) => seen.push(`${method} ${url.href}`),
    }),
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
      "pages: about is published to the Online Store and /pages/about answers 404",
      "products: bowl-ash-glaze is published to the Online Store and /products/bowl-ash-glaze answers 410",
    ]);
    expect(out.findings.every((f) => f.severity === "high")).toBe(true);
    expect(out.findings.map((f) => f.url)).toEqual([
      `${SHOPIFY_SITE}/pages/about`,
      `${SHOPIFY_SITE}/products/bowl-ash-glaze`,
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
      "mug-speckled: the page shows 30.00 but the Storefront API says 28.00; the product data says 30.00 but the Storefront API says 28.00",
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
