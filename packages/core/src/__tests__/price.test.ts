import { describe, expect, it } from "vitest";
import { startFixture } from "../../../fixtures/src/index.js";
import { createFetcher, type Hop } from "../fetcher.js";
import { comparePrices, parseAmount, readPrices, shopifyProductJs } from "../price.js";
import { buildSnapshot } from "../snapshot.js";

async function read(path: string) {
  const site = await startFixture("price-stores");
  try {
    const fetcher = createFetcher({ allowPrivate: true });
    const page = buildSnapshot(await fetcher.get(`${site.origin}${path}`));
    const reading = await readPrices(page, fetcher);
    return { reading, hits: new Map(site.hits), methods: new Map(site.methods) };
  } finally {
    await site.close();
  }
}

const pageOf = (url: string, body: string) =>
  buildSnapshot([{ url, status: 200, headers: { "content-type": "text/html" }, body, ms: 1 }]);

describe("prices: unit", () => {
  it("amounts are integers in minor units", () => {
    expect(parseAmount("$48")).toBe(4800);
    expect(parseAmount("48.00 USD")).toBe(4800);
    expect(parseAmount("€48,00")).toBe(4800);
    expect(parseAmount("$1,234.50")).toBe(123450);
    expect(parseAmount("From $20.00")).toBe(2000);
    expect(parseAmount("free")).toBeUndefined();
  });

  it("readPrices on the fixture mug: $48 visible, 48.00 in JSON-LD and 5200 in the product JSON", async () => {
    const { reading } = await read("/products/mug");
    expect(reading).toMatchObject({
      visible: 4800,
      structured: 4800,
      charged: 5200,
      currency: "USD",
      availability: "InStock",
    });
  });

  it("comparePrices: all equal, one differs, one missing (compared on the two that exist)", () => {
    expect(comparePrices({ visible: 4800, structured: 4800, charged: 4800 })).toEqual([]);
    expect(
      comparePrices({ visible: 4800, structured: 4800, charged: 5200 }).map((d) => d.message),
    ).toEqual([
      "the page shows 48.00 but the store charges 52.00",
      "the product data says 48.00 but the store charges 52.00",
    ]);
    expect(comparePrices({ visible: 3000, structured: 3000 })).toEqual([]);
    expect(comparePrices({ visible: 3000, structured: 2900 }).map((d) => d.kind)).toEqual([
      "amount",
    ]);
  });

  it("the Shopify product JSON address, from a product page address", () => {
    expect(shopifyProductJs("https://shop.example/products/mug?variant=2")).toBe(
      "https://shop.example/products/mug.js",
    );
    expect(shopifyProductJs("https://shop.example/collections/all/products/mug")).toBe(
      "https://shop.example/products/mug.js",
    );
    expect(shopifyProductJs("https://shop.example/pages/about")).toBeUndefined();
  });
});

describe("prices: integration (the price-stores fixture)", () => {
  it("a page not on Shopify: charged is undefined and no extra request is made", async () => {
    const { reading, hits, methods } = await read("/products/bowl");
    expect(reading.charged).toBeUndefined();
    expect(reading).toMatchObject({ visible: 3000, structured: 3000 });
    expect([...hits.keys()]).toEqual(["/products/bowl"]);
    expect([...methods.keys()]).toEqual(["GET"]);
  });

  it("in stock in the product data for something that can't be bought", async () => {
    const { reading } = await read("/products/sold");
    expect(reading.canBuy).toBe(false);
    expect(comparePrices(reading)).toEqual([
      { kind: "stock", message: "the product data says InStock but the product can't be bought" },
    ]);
  });
});

describe("prices: edge cases", () => {
  it("several variants: the variant the page selects is compared, and named", async () => {
    const site = await startFixture("price-stores");
    try {
      const fetcher = createFetcher({ allowPrivate: true });
      const page = buildSnapshot(await fetcher.get(`${site.origin}/products/vase?variant=2`));
      const reading = await readPrices(page, fetcher);
      expect(reading).toMatchObject({
        structured: 3500,
        charged: 3500,
        variant: "Large",
        visible: 2000,
        startingPrice: true,
      });
      expect(comparePrices(reading).map((d) => d.message)).toEqual([
        'the page shows 20.00 (a starting price, "From") but the product data says 35.00',
        'the page shows 20.00 (a starting price, "From") but the store charges 35.00',
      ]);
    } finally {
      await site.close();
    }
  });

  it('a price shown as "From $48": visible is 4800, marked as a starting price', async () => {
    const reading = await readPrices(
      pageOf("https://shop.example/products/x", '<span class="price">From $48</span>'),
    );
    expect(reading).toEqual({ visible: 4800, startingPrice: true });
  });

  it("a currency that differs between the page and the product data is a disagreement, never converted", () => {
    const page = pageOf(
      "https://shop.example/products/x",
      `<span class="price">€48,00</span><script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        offers: { price: "48.00", priceCurrency: "USD" },
      })}</script>`,
    );
    return readPrices(page).then((r) => {
      expect(r).toMatchObject({
        visible: 4800,
        visibleCurrency: "EUR",
        structured: 4800,
        currency: "USD",
      });
      expect(comparePrices(r)).toEqual([
        {
          kind: "currency",
          message: "the page shows EUR but the product data says USD (amounts are not converted)",
        },
      ]);
    });
  });

  it("product JSON that isn't JSON leaves charged unknown", async () => {
    const page = pageOf(
      "https://shop.example/products/x",
      '<script src="https://cdn.shopify.com/t.js"></script><span class="price">$5</span>',
    );
    const fetcher = {
      get: async (url: string): Promise<Hop[]> => [
        { url, status: 200, headers: {}, body: "<html>", ms: 1 },
      ],
      getSite: async () => [],
      stats: { requests: 0, maxInFlight: 0 },
    };
    expect(await readPrices(page, fetcher)).toEqual({ visible: 500 });
  });
});
