import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createFetcher } from "@gaugeline/core";
import { readerFromEnv } from "../packages/playwright/src/content.js";
import { expect, test as base } from "../packages/playwright/src/index.js";
import { sanityCountsTransport } from "../packages/testkit/src/index.js";

/**
 * The Playwright helper (G33) against a fixture shop and recorded content: Fernhill Roasters,
 * invented. The shop's pages are served on 127.0.0.1 by this file; the content is the helper's
 * invented dataset, read through the same reader the helper uses, over a stand-in for Sanity's
 * query API. No real site, no real Sanity project, no real key.
 */
const dataset = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../packages/playwright/fixtures/dataset.json", import.meta.url)),
    "utf8",
  ),
) as { documents: Record<string, unknown>[] };

/** Built at run time: a token-shaped string must not sit in the repository as one piece. */
const TOKEN = ["sk", "viewer", "fernhill", "0042"].join("");
const read = readerFromEnv(
  { SANITY_PROJECT_ID: "fernhill1", SANITY_DATASET: "production", SANITY_TOKEN: TOKEN },
  createFetcher({
    transport: sanityCountsTransport({ types: {}, content: { all: dataset.documents } }),
    timeoutMs: 5000,
  }),
);

/** What the shop page prints, by path. Planted: a price on a page that differs from the checkout price. */
const test = base.extend<{ planted: Record<string, string> }>({
  planted: [{}, { option: true }],
  // The shop: each /products/<slug> page shows the checkout price of the published product with that slug.
  baseURL: async ({ planted }, use) => {
    const prices = new Map<string, string>();
    for (const d of dataset.documents) {
      const slug = (d.slug as { current?: string } | undefined)?.current;
      if (typeof slug === "string" && !String(d._id).startsWith("drafts."))
        prices.set(`/products/${slug}`, String(d.checkoutPrice));
    }
    const server: Server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const price = planted[path] ?? prices.get(path);
      res.writeHead(price === undefined ? 404 : 200, {
        "content-type": "text/html; charset=utf-8",
      });
      res.end(
        price === undefined
          ? "<h1>Not found</h1>"
          : `<h1>Product</h1><p data-testid="price">${price}</p>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  },
});

test.use({ gaugeline: { read, routes: { product: "/products/{slug}" }, seed: "fernhill" } });

test("the docs example: every product shows the checkout price", async ({ page, content }) => {
  let visited = 0;
  for await (const product of content.published("product")) {
    await page.goto(product.url);
    await expect(page.getByTestId("price"), product.url).toHaveText(product.checkoutPrice);
    visited++;
  }
  expect(visited).toBe(4); // the gift card has no page and is skipped; the draft is never read
  expect(content.skipped.map((s) => s.id)).toEqual(["p-gift"]);
});

test("a sample of two products opens the same two pages every run", async ({ page, content }) => {
  const visit = async (): Promise<string[]> => {
    const urls: string[] = [];
    for await (const product of content.sample("product", 2)) {
      await page.goto(product.url);
      await expect(page.getByTestId("price"), product.url).toHaveText(product.checkoutPrice);
      urls.push(product.url);
    }
    return urls;
  };
  const first = await visit();
  expect(first).toHaveLength(2);
  expect(await visit()).toEqual(first);
});

test.describe("one planted mismatch", () => {
  test.use({ planted: { "/products/harbour-decaf": "$15.00" } });

  test("fails with the product URL in the message", async ({ page, content }) => {
    let failure: Error | undefined;
    try {
      for await (const product of content.published("product")) {
        await page.goto(product.url);
        await expect(page.getByTestId("price"), product.url).toHaveText(product.checkoutPrice, {
          timeout: 1000,
        });
      }
    } catch (error) {
      failure = error as Error;
    }
    expect(failure, "the mismatch should have failed the loop").toBeDefined();
    // Playwright colours the expected and received values; the words are what is asserted.
    const message = stripVTControlCharacters(failure?.message ?? "");
    expect(message).toContain("/products/harbour-decaf");
    expect(message).toContain("15.50"); // what the checkout says
    expect(message).toContain("15.00"); // what the page shows
    expect(message).not.toContain("/products/ember-house-blend");
  });
});

test("zero documents of a type fails loudly instead of passing an empty loop", async ({
  content,
}) => {
  await expect(async () => {
    for await (const doc of content.published("producct")) void doc;
  }).rejects.toThrow(/No published "producct" documents/);
});
