import { describe, expect, it } from "vitest";
import { createSquarespaceCommerceAdapter } from "../../adapters/squarespace-commerce.js";
import {
  readSquarespaceCommerce,
  type SquarespaceCommerceReading,
} from "../../adapters/squarespace-commerce-read.js";
import {
  HEALTHY_PAGES,
  SQUARESPACE_COMMERCE_HOST,
  SQUARESPACE_COMMERCE_MARKERS,
  SQUARESPACE_COMMERCE_PRODUCTS,
  SQUARESPACE_COMMERCE_SITE,
  squarespaceStoreTransport,
  type FixtureProduct,
  type ShopPages,
  type SquarespaceCommerceFixtureOptions,
} from "../../adapters/__tests__/squarespace-commerce-fixture.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import {
  SQUARESPACE_COMMERCE_CHECKS,
  createSquarespaceCommerceRegistry,
} from "../squarespace-commerce.js";

const KEY = testKey("squarespace-commerce-checks");

async function reading(
  pages: ShopPages,
  over: {
    api?: SquarespaceCommerceFixtureOptions;
    products?: readonly FixtureProduct[];
    urls?: Record<string, string>;
    maxPages?: number;
  } = {},
): Promise<{ reading: SquarespaceCommerceReading; seen: string[] }> {
  const seen: string[] = [];
  const fetcher = createFetcher({
    transport: squarespaceStoreTransport(
      pages,
      {
        token: KEY,
        onRequest: (method, url, headers) =>
          seen.push(`${method} ${url.href}${headers.authorization ? " [auth]" : ""}`),
        ...over.api,
      },
      over.products,
    ),
    timeoutMs: 5000,
  });
  const adapter = createSquarespaceCommerceAdapter({
    env: { SQUARESPACE_COMMERCE_TOKEN: KEY },
    fetcher,
    ...(over.urls ? { settings: { id: "squarespace-commerce", urls: over.urls } } : {}),
    sleep: () => Promise.resolve(),
  });
  return {
    reading: await readSquarespaceCommerce({
      adapter,
      fetcher,
      site: SQUARESPACE_COMMERCE_SITE,
      ...(over.maxPages !== undefined ? { maxPages: over.maxPages } : {}),
    }),
    seen,
  };
}

const run = (r: SquarespaceCommerceReading) => runChecks(r, createSquarespaceCommerceRegistry());
const evidence = (r: Awaited<ReturnType<typeof run>>, id: string): string[] =>
  r.findings.filter((f) => f.checkId === id).map((f) => f.evidence);
const reasons = (r: Awaited<ReturnType<typeof run>>): string =>
  r.couldNotCheck.map((c) => `${c.id}: ${c.reason}`).join("\n");

describe("Squarespace commerce checks: a pop-up print shop", () => {
  it("a healthy store has no finding from either check, and both pass", async () => {
    const { reading: r } = await reading(HEALTHY_PAGES);
    expect(r.visible).toBe(3);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed.sort()).toEqual(["squarespace-price-differs", "squarespace-stock-differs"]);
  });

  it("the draft product has no live page, so its page is never asked", async () => {
    const { seen } = await reading(HEALTHY_PAGES);
    expect(seen.some((s) => s.includes("winter-card-set"))).toBe(false);
    expect(seen.filter((s) => s.includes(SQUARESPACE_COMMERCE_SITE))).toHaveLength(3);
  });

  it("the key goes to the API host and never to the shop's pages", async () => {
    const { seen } = await reading(HEALTHY_PAGES);
    const shop = seen.filter((s) => s.includes(SQUARESPACE_COMMERCE_SITE));
    const api = seen.filter((s) => s.includes(SQUARESPACE_COMMERCE_HOST));
    expect(shop.length).toBeGreaterThan(0);
    expect(shop.some((s) => s.includes("[auth]"))).toBe(false);
    expect(api.every((s) => s.includes("[auth]"))).toBe(true);
    expect(seen.every((s) => s.startsWith("GET "))).toBe(true);
  });

  describe("price", () => {
    it("positive: the page still shows the full price of a tote that is on sale", async () => {
      const out = await run(
        (
          await reading({
            ...HEALTHY_PAGES,
            "/shop/tide-chart-tote": { price: "40.00", availability: "OutOfStock" },
          })
        ).reading,
      );
      expect(evidence(out, "squarespace-price-differs")).toEqual([
        "tide-chart-tote: the page shows 40.00 USD and the Commerce API has 32.00 USD",
      ]);
      expect(out.findings).toHaveLength(1);
      expect(out.findings[0]?.severity).toBe("high");
      expect(out.findings[0]?.url).toBe(`${SQUARESPACE_COMMERCE_SITE}/shop/tide-chart-tote`);
    });

    it("negative: any one of a product's variant prices is a price the page may show", async () => {
      const out = await run(
        (
          await reading({
            ...HEALTHY_PAGES,
            "/shop/harbour-at-dawn": { price: "45.00", availability: "InStock" },
          })
        ).reading,
      );
      expect(evidence(out, "squarespace-price-differs")).toEqual([]);
    });

    it("a visible 'From' price must be the lowest, not merely one of the variants", async () => {
      const out = await run(
        (
          await reading({
            ...HEALTHY_PAGES,
            "/shop/harbour-at-dawn": { visible: "From $45.00" },
          })
        ).reading,
      );
      expect(evidence(out, "squarespace-price-differs")).toEqual([
        "harbour-at-dawn: the page shows 45.00 USD and the Commerce API has 28.00 USD, 45.00 USD",
      ]);
    });

    it("prices are compared as integers: 9.50 and 9.5 are the same price", async () => {
      const out = await run(
        (
          await reading({
            ...HEALTHY_PAGES,
            "/shop/sea-glass-zine": { price: "9.5", availability: "InStock" },
          })
        ).reading,
      );
      expect(evidence(out, "squarespace-price-differs")).toEqual([]);
    });

    it("a page in another currency is could-not-check, never converted and never a finding", async () => {
      const out = await run(
        (
          await reading({
            ...HEALTHY_PAGES,
            "/shop/sea-glass-zine": { price: "9.50", currency: "EUR", availability: "InStock" },
          })
        ).reading,
      );
      expect(evidence(out, "squarespace-price-differs")).toEqual([]);
      expect(reasons(out)).toMatch(
        /prices it in EUR and the store in USD, which are not converted/,
      );
    });

    it("a page with no price, and a page that answers 404, are could-not-check and never a pass", async () => {
      const out = await run(
        (
          await reading({
            ...HEALTHY_PAGES,
            "/shop/sea-glass-zine": { availability: "InStock" },
            "/shop/tide-chart-tote": 404,
          })
        ).reading,
      );
      expect(evidence(out, "squarespace-price-differs")).toEqual([]);
      expect(reasons(out)).toMatch(
        /1 product page shows no price Gaugeline can read \(sea-glass-zine\)/,
      );
      expect(reasons(out)).toMatch(/answers 404, so its price was not compared/);
    });

    it("a variant whose price cannot be read makes a mismatch could-not-check, not a finding", async () => {
      const odd = SQUARESPACE_COMMERCE_PRODUCTS.map((p) =>
        p.id === "p-dawn"
          ? { ...p, variants: [p.variants[0]!, { ...p.variants[1]!, base: "forty-five" }] }
          : p,
      );
      const out = await run(
        (
          await reading(
            {
              ...HEALTHY_PAGES,
              "/shop/harbour-at-dawn": { price: "99.00", availability: "InStock" },
            },
            { products: odd },
          )
        ).reading,
      );
      expect(evidence(out, "squarespace-price-differs")).toEqual([]);
      expect(reasons(out)).toMatch(/a variant's price could not be read/);
    });
  });

  describe("stock", () => {
    it("positive: the page offers the sold-out tote as in stock", async () => {
      const out = await run(
        (
          await reading({
            ...HEALTHY_PAGES,
            "/shop/tide-chart-tote": { price: "32.00", availability: "InStock" },
          })
        ).reading,
      );
      expect(evidence(out, "squarespace-stock-differs")).toEqual([
        "tide-chart-tote: the page offers it as in stock and the Inventory API says every variant is out of stock",
      ]);
      expect(out.findings[0]?.severity).toBe("medium");
    });

    it("positive: the page says sold out for a zine with unlimited stock", async () => {
      const out = await run(
        (
          await reading({
            ...HEALTHY_PAGES,
            "/shop/sea-glass-zine": { price: "9.50", availability: "SoldOut" },
          })
        ).reading,
      );
      expect(evidence(out, "squarespace-stock-differs")).toEqual([
        "sea-glass-zine: the page offers it as out of stock and the Inventory API says a variant is in stock",
      ]);
    });

    it("negative: a print with one size sold out is in stock while the other size is", async () => {
      const partly = SQUARESPACE_COMMERCE_PRODUCTS.map((p) =>
        p.id === "p-dawn"
          ? { ...p, variants: [{ ...p.variants[0]!, stock: 0 }, p.variants[1]!] }
          : p,
      );
      const out = await run((await reading(HEALTHY_PAGES, { products: partly })).reading);
      expect(evidence(out, "squarespace-stock-differs")).toEqual([]);
    });

    it("a variant with no inventory row is never read as out of stock", async () => {
      const noRow = SQUARESPACE_COMMERCE_PRODUCTS.map((p) =>
        p.id === "p-tote" ? { ...p, variants: [{ ...p.variants[0]!, stock: undefined }] } : p,
      );
      const out = await run(
        (
          await reading(
            {
              ...HEALTHY_PAGES,
              "/shop/tide-chart-tote": { price: "32.00", availability: "InStock" },
            },
            { products: noRow },
          )
        ).reading,
      );
      expect(evidence(out, "squarespace-stock-differs")).toEqual([]);
      expect(reasons(out)).toMatch(/no row for one of its variants/);
    });

    it("a page with no availability is could-not-check for stock, and its price is still compared", async () => {
      const out = await run(
        (await reading({ ...HEALTHY_PAGES, "/shop/sea-glass-zine": { price: "12.00" } })).reading,
      );
      expect(evidence(out, "squarespace-price-differs")).toHaveLength(1);
      expect(evidence(out, "squarespace-stock-differs")).toEqual([]);
      expect(reasons(out)).toMatch(
        /squarespace-stock-differs: .*no stock Gaugeline can read \(sea-glass-zine\)/,
      );
    });
  });

  describe("a key without a permission is could-not-check for that part only", () => {
    it("no Inventory permission: prices are still compared, stock is could-not-check", async () => {
      const out = await run(
        (
          await reading(
            {
              ...HEALTHY_PAGES,
              "/shop/tide-chart-tote": { price: "40.00", availability: "InStock" },
            },
            { api: { inventory: "forbidden" } },
          )
        ).reading,
      );
      expect(evidence(out, "squarespace-price-differs")).toHaveLength(1);
      expect(evidence(out, "squarespace-stock-differs")).toEqual([]);
      expect(out.passed).not.toContain("squarespace-stock-differs");
      expect(reasons(out)).toMatch(
        /squarespace-stock-differs: .*Inventory API was not read.*did not let the key read inventory \(HTTP 403\)/,
      );
    });

    it("no Products permission: nothing is compared, both checks are could-not-check, none passes", async () => {
      const r = (
        await reading(HEALTHY_PAGES, {
          api: { token: "another-key-that-is-not-the-one-in-use-0123456789" },
        })
      ).reading;
      expect(r.unreadable).toMatch(/did not accept SQUARESPACE_COMMERCE_TOKEN \(HTTP 401\)/);
      const out = await run(r);
      expect(out.findings).toEqual([]);
      expect(out.passed).toEqual([]);
      expect(out.couldNotCheck).toHaveLength(2);
    });
  });

  it("a store with no visible product is could-not-check, not a clean pass", async () => {
    const hidden = SQUARESPACE_COMMERCE_PRODUCTS.map((p) => ({ ...p, isVisible: false }));
    const out = await run((await reading(HEALTHY_PAGES, { products: hidden })).reading);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toMatch(/lists no visible product/);
  });

  it("a product page budget that is used is said, not skipped quietly", async () => {
    const { reading: r, seen } = await reading(HEALTHY_PAGES, { maxPages: 1 });
    expect(r.pagesSkipped).toBe(2);
    expect(seen.filter((s) => s.includes(SQUARESPACE_COMMERCE_SITE))).toHaveLength(1);
    expect(reasons(await run(r))).toMatch(/2 product pages were not asked for/);
  });

  it("a product with no address is could-not-check by id, and an address on another site is never asked", async () => {
    const strays = SQUARESPACE_COMMERCE_PRODUCTS.map((p) =>
      p.id === "p-tote"
        ? { ...p, url: "" }
        : p.id === "p-zine"
          ? { ...p, url: "https://elsewhere.example/shop/z" }
          : p,
    );
    const { reading: r, seen } = await reading(HEALTHY_PAGES, { products: strays });
    // The path of an https address is kept (the page is asked on this site); a missing one has no pattern.
    expect(r.unaddressed.map((u) => u.id)).toEqual(["p-tote"]);
    expect(seen.some((s) => s.includes("elsewhere.example"))).toBe(false);
    const withPattern = await reading(HEALTHY_PAGES, {
      products: strays,
      urls: { products: "/shop/{slug}" },
    });
    expect(withPattern.reading.unaddressed).toEqual([]);
  });

  it("no finding or could-not-check line carries a word of the client's content", async () => {
    const out = await run(
      (
        await reading({
          ...HEALTHY_PAGES,
          "/shop/tide-chart-tote": { price: "40.00", availability: "InStock" },
          "/shop/sea-glass-zine": { availability: "SoldOut" },
        })
      ).reading,
    );
    const text = JSON.stringify([out.findings, out.couldNotCheck]);
    for (const marker of Object.values(SQUARESPACE_COMMERCE_MARKERS))
      expect(text).not.toContain(marker);
    expect(text).not.toContain(KEY);
  });

  it("the checks are registered under their own ids and never say which side is right", () => {
    expect(SQUARESPACE_COMMERCE_CHECKS.map((c) => c.id)).toEqual([
      "squarespace-price-differs",
      "squarespace-stock-differs",
    ]);
    for (const c of SQUARESPACE_COMMERCE_CHECKS) expect(c.why).not.toMatch(/is wrong|is correct/);
  });
});
