# @gaugeline/playwright

Playwright's `test` and `expect` with one extra fixture, `content`: test every product, post and page by looping over your real published Sanity content. It is read-only: it only reads published documents, with GET requests and a Viewer token, and it never writes to your dataset. It does not launch a browser; your own Playwright does.

```ts
import { test, expect } from "@gaugeline/playwright";

test.use({ gaugeline: { routes: { product: "/products/{slug}" } } });

test("every product shows the checkout price", async ({ page, content }) => {
  for await (const product of content.published("product")) {
    await page.goto(product.url);
    await expect(page.getByTestId("price"), product.url).toHaveText(product.checkoutPrice);
  }
});
```

`content.sample("product", 25)` opens a seeded sample instead, so a big catalogue stays fast and a failure can be replayed (`GAUGELINE_SEED`). A type with no published documents fails loudly rather than passing an empty loop; a document with no address is listed and skipped.

Docs: https://github.com/alvinwquach/gaugeline/blob/main/docs/playwright.md
