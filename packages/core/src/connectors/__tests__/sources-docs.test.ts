import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { useCassette } from "../../../../testkit/src/index.js";
import { createFetcher } from "../../fetcher.js";
import { runConnectors } from "../run.js";
import { SHOPIFY_MAX_PAGES, SHOPIFY_PAGE_SIZE, shopifyConnector } from "../shopify.js";
import { SQUARE_MAX_PAGES, squareConnector } from "../square.js";
import { serving } from "./serve.js";

const read = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../../../docs/sources/${name}.md`, import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
const block = (page: string, title: string): string | undefined =>
  new RegExp(`\`\`\`json title=${title}\n([\\s\\S]*?)\n\`\`\``).exec(page)?.[1];

// Built at run time: GitHub push protection rejects key-shaped literals.
const SHOPIFY_TOKEN = ["shp", "at", "ridgeline0123456789abcdef"].join("");
const SQUARE_TOKEN = ["EAAA", "ridgelinestudio0123456789abcdefghij"].join("");

describe("docs/sources/shopify.md: the coach's shop", () => {
  const page = read("shopify");
  const env = { SHOPIFY_ACCESS_TOKEN: SHOPIFY_TOKEN, SHOPIFY_SHOP_DOMAIN: "ridgeline-coaching" };

  it("the products block is what the connector returns for the hoodie in the recorded shop", async () => {
    const run = await runConnectors(
      [shopifyConnector],
      env,
      createFetcher({ transport: useCassette("shopify-shop", { mode: "replay" }) }),
    );
    expect(run.notices).toEqual([]);
    const hoodie = (run.data.get("shopify") as Array<{ id: string }>).filter(
      (p) => p.id === "7001",
    );
    expect(block(page, "Shopify products")).toBe(JSON.stringify(hoodie, null, 2));
  });

  it("the notices block is what a wrong token gets, and the token is not in it", async () => {
    const refused = await runConnectors(
      [shopifyConnector],
      env,
      serving(() => ({ status: 401 })),
    );
    expect(block(page, "Shopify notices")).toBe(JSON.stringify(refused.notices, null, 2));
    expect(JSON.stringify(refused.notices)).not.toContain(SHOPIFY_TOKEN);
  });

  it("the page's numbers hold: $48 on the page, $54 and $58.50 in the shop, the large sold out", async () => {
    const run = await runConnectors(
      [shopifyConnector],
      env,
      createFetcher({ transport: useCassette("shopify-shop", { mode: "replay" }) }),
    );
    const hoodie = (
      run.data.get("shopify") as Array<{
        id: string;
        variants: Array<{ sku?: string; price: number | null; available: boolean | null }>;
      }>
    ).find((p) => p.id === "7001");
    expect(hoodie?.variants.map((v) => [v.sku, v.price, v.available])).toEqual([
      ["RL-HOOD-S", 5400, true],
      ["RL-HOOD-M", 5400, true],
      ["RL-HOOD-L", 5850, false],
    ]);
    expect(page).toContain("$48.00");
    expect(page).toContain("$54.00");
    expect(page).toContain("$58.50");
  });

  it("the limits the page states are the ones in the code", () => {
    expect(page).toContain(`${SHOPIFY_PAGE_SIZE} products a page`);
    expect(page).toContain(`At most ${SHOPIFY_MAX_PAGES} pages (10,000 products)`);
    expect(SHOPIFY_MAX_PAGES * SHOPIFY_PAGE_SIZE).toBe(10_000);
  });

  it("names the narrowest scope and the variables the connector declares", () => {
    expect(page).toContain("`read_products`");
    for (const name of [...shopifyConnector.envVars, ...(shopifyConnector.optionalEnvVars ?? [])])
      expect(page, name).toContain(`\`${name}\``);
  });
});

describe("docs/sources/square.md: the studio front desk", () => {
  const page = read("square");
  const env = { SQUARE_ACCESS_TOKEN: SQUARE_TOKEN };

  it("the items block is what the connector returns for the hoodie in the recorded catalogue", async () => {
    const run = await runConnectors(
      [squareConnector],
      env,
      createFetcher({ transport: useCassette("square-shop", { mode: "replay" }) }),
    );
    expect(run.notices).toEqual([]);
    const hoodie = (run.data.get("square") as Array<{ name: string }>).filter(
      (p) => p.name === "Training hoodie",
    );
    expect(block(page, "Square items")).toBe(JSON.stringify(hoodie, null, 2));
  });

  it("the notices block is what a token without the permission gets, and the token is not in it", async () => {
    const run = await runConnectors(
      [squareConnector],
      env,
      serving(() => ({ status: 403 })),
    );
    expect(block(page, "Square notices")).toBe(JSON.stringify(run.notices, null, 2));
    expect(JSON.stringify(run.notices)).not.toContain(SQUARE_TOKEN);
  });

  it("the limits the page states are the ones in the code, and the variable is the one declared", () => {
    expect(page).toContain(`At most ${SQUARE_MAX_PAGES} pages`);
    expect(page).toContain("`ITEMS_READ`");
    for (const name of squareConnector.envVars) expect(page, name).toContain(`\`${name}\``);
  });
});
