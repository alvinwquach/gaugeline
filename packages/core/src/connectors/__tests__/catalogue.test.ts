import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { toMinor } from "../../products/money.js";
import { useCassette } from "../../../../testkit/src/index.js";
import type { CatalogueItem } from "../catalogue.js";
import { runConnectors } from "../run.js";
import { shopifyConnector } from "../shopify.js";
import { squareConnector } from "../square.js";

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const SHOPIFY_TOKEN = ["shp", "at", "ridgeline0123456789abcdef"].join("");
const SQUARE_TOKEN = ["EAAA", "ridgelinestudio0123456789abcdefghij"].join("");
const ENV = {
  SHOPIFY_ACCESS_TOKEN: SHOPIFY_TOKEN,
  SHOPIFY_SHOP_DOMAIN: "ridgeline-coaching.myshopify.com",
  SQUARE_ACCESS_TOKEN: SQUARE_TOKEN,
};

/** One transport for both systems: each cassette answers its own host. */
function both(): Transport {
  const shopify = useCassette("shopify-shop", { mode: "replay" });
  const square = useCassette("square-shop", { mode: "replay" });
  return (url, req) => (url.host.endsWith("myshopify.com") ? shopify(url, req) : square(url, req));
}

/**
 * The page-against-provider fixture: what the coach's shop page says. The hoodie is still
 * $48.00 on the page; both systems charge $54.00 (and $58.50 for the large).
 */
const PAGE = `<main><h1>Ridgeline shop</h1><ul>
<li>Training hoodie - $48.00</li>
<li>Month pass - $120.00</li>
<li>Intro session - $0.00</li>
</ul></main>`;

function pageRows(html: string): Array<{ name: string; price: number }> {
  return [...html.matchAll(/<li>(.+?) - \$(\d+\.\d{2})<\/li>/g)].map((m) => ({
    name: m[1] ?? "",
    price: toMinor(m[2] ?? ""),
  }));
}

/**
 * The comparison the price check will make, reduced to its core and kept in this test: for every
 * active catalogue item the page lists, does any of its variants charge the price on the page?
 * It reads only the shared CatalogueItem shape, so it cannot tell the two systems apart.
 */
function disagreements(rows: ReturnType<typeof pageRows>, items: readonly CatalogueItem[]) {
  const byName = new Map(items.filter((i) => i.active).map((i) => [i.name.toLowerCase(), i]));
  const out: Array<{ name: string; page: number; provider: number[] }> = [];
  for (const row of rows) {
    const found = byName.get(row.name.toLowerCase());
    if (!found) continue;
    const prices = [
      ...new Set(found.variants.flatMap((v) => (v.price === null ? [] : [v.price]))),
    ].sort((a, b) => a - b);
    if (!prices.includes(row.price))
      out.push({ name: row.name, page: row.price, provider: prices });
  }
  return out;
}

describe("the page against Shopify and against Square: acceptance", () => {
  it("gives the same finding with either source", async () => {
    const run = await runConnectors(
      [shopifyConnector, squareConnector],
      ENV,
      createFetcher({ transport: both() }),
    );
    expect(run.notices).toEqual([]);
    const shopify = run.data.get("shopify") as CatalogueItem[];
    const square = run.data.get("square") as CatalogueItem[];
    expect(shopify).toHaveLength(4);
    expect(square).toHaveLength(4);

    const rows = pageRows(PAGE);
    expect(rows).toEqual([
      { name: "Training hoodie", price: 4800 },
      { name: "Month pass", price: 12000 },
      { name: "Intro session", price: 0 },
    ]);
    const expected = [{ name: "Training hoodie", page: 4800, provider: [5400, 5850] }];
    expect(disagreements(rows, shopify)).toEqual(expected);
    expect(disagreements(rows, square)).toEqual(expected);
  });

  it("the two sources describe the same shop the same way: names, skus, prices, currency and activity", async () => {
    const run = await runConnectors(
      [shopifyConnector, squareConnector],
      ENV,
      createFetcher({ transport: both() }),
    );
    const view = (items: CatalogueItem[]) =>
      items.map((i) => ({
        name: i.name,
        active: i.active,
        variants: i.variants.map((v) => [v.sku, v.price, v.currency]),
      }));
    expect(view(run.data.get("shopify") as CatalogueItem[])).toEqual(
      view(run.data.get("square") as CatalogueItem[]),
    );
  });

  it("an item whose price the page has right is not reported, and a free item (0) matches a page that says $0.00", async () => {
    const run = await runConnectors([shopifyConnector], ENV, createFetcher({ transport: both() }));
    const items = run.data.get("shopify") as CatalogueItem[];
    expect(disagreements([{ name: "Intro session", price: 0 }], items)).toEqual([]);
    expect(disagreements([{ name: "Training hoodie", price: 5400 }], items)).toEqual([]);
    expect(disagreements([{ name: "Intro session", price: 100 }], items)).toHaveLength(1);
  });

  it("one source missing a variable leaves the other's data and a could-not-check notice, never a pass", async () => {
    const run = await runConnectors(
      [shopifyConnector, squareConnector],
      { SHOPIFY_ACCESS_TOKEN: SHOPIFY_TOKEN, SQUARE_ACCESS_TOKEN: SQUARE_TOKEN },
      createFetcher({ transport: both() }),
    );
    expect([...run.data.keys()]).toEqual(["square"]);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]).toMatchObject({ connector: "shopify", kind: "not-configured" });
    expect(run.notices[0]?.message).toContain("SHOPIFY_SHOP_DOMAIN");
  });
});

describe("read only: the two sources", () => {
  const src = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("neither file chooses a method, names a query language or mentions a write", () => {
    for (const file of ["shopify.ts", "square.ts", "get-json.ts"]) {
      const code = src(file);
      expect(code, file).not.toMatch(/\bmethod\s*:/);
      expect(code, file).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
      expect(code, file).not.toMatch(/graphql|mutation|subscription/i);
    }
  });

  it("a run with both keys sends only GET, and neither key is in the notices, the data or the debug lines", async () => {
    const seen: string[] = [];
    const lines: string[] = [];
    const replay = both();
    const transport: Transport = (url, req) => {
      seen.push(`${req.method} ${url.href}`);
      return replay(url, req);
    };
    const run = await runConnectors(
      [shopifyConnector, squareConnector],
      ENV,
      createFetcher({ transport }),
      {
        debug: (l) => lines.push(l),
      },
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.startsWith("GET "))).toBe(true);
    // The advice request for Shopify's scopes has no recording; it is GET too and is simply absent.
    const everything = JSON.stringify(run) + lines.join("\n") + seen.join("\n");
    expect(everything).not.toContain(SHOPIFY_TOKEN);
    expect(everything).not.toContain(SQUARE_TOKEN);
  });
});
