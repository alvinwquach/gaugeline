---
notReleased: true
---

# Playwright helper

Test every page with your real content.

::: warning
<b>Not released yet.</b> The package is built and tested here. It is not on npm until the first release.
:::

If you build sites for small businesses on Sanity, you already have a Playwright suite, or you want one. The usual trouble is that it tests three pages you picked by hand, while the shop has sixty products and an editor adds more every week. `@gaugeline/playwright` hands your tests the real published documents, so one test covers every product, post and page.

It is Playwright's own `test` and `expect`, re-exported with one extra fixture, `content`. Nothing else changes in how you write or run tests. It does not start a browser of its own: your Playwright does that, as it always has.

```sh
npm install --save-dev @gaugeline/playwright @playwright/test
```

## A test for every product

A coffee roaster's shop keeps each product's checkout price in Sanity. This test opens every product page and checks the page shows that price.

```ts title=prices.spec.ts
import { test, expect } from "@gaugeline/playwright";

test.use({ gaugeline: { routes: { product: "/products/{slug}" } } });

test("every product shows the checkout price", async ({ page, content }) => {
  for await (const product of content.published("product")) {
    await page.goto(product.url);
    await expect(page.getByTestId("price"), product.url).toHaveText(product.checkoutPrice);
  }
});
```

Set `SANITY_PROJECT_ID`, `SANITY_DATASET` (default `production`) and, for a private dataset, `SANITY_TOKEN`, then run `npx playwright test`. Each `product` is `{ url, ...fields }`: every field the document has in Sanity, plus the `url` to open. `content.published` returns an async iterable, so write `for await`.

Pass `product.url` as the second argument to `expect`. Playwright puts it first in the failure message, so a failure names the page.

Here is what it printed against the repository's fixture shop, Tidewater Coffee Roasters (an invented business), with its content recorded in a file. The fixture's spec is [`e2e/playwright-helper.spec.ts`](https://github.com/alvinwquach/gaugeline/blob/main/e2e/playwright-helper.spec.ts):

```text
Running 4 tests using 1 worker
  ✓  1 e2e/playwright-helper.spec.ts:65:1 › the docs example: every product shows the checkout price (376ms)
  ✓  2 e2e/playwright-helper.spec.ts:76:1 › a sample of two products opens the same two pages every run (280ms)
  ✓  3 e2e/playwright-helper.spec.ts:94:3 › one planted mismatch › fails with the product URL in the message (1.2s)
  ✓  4 e2e/playwright-helper.spec.ts:116:1 › zero documents of a type fails loudly instead of passing an empty loop (11ms)
  4 passed (3.6s)
```

Test 1 is the example above. The gift card in that dataset has no page, so it was listed and skipped ([see below](#documents-with-no-page)); the unpublished draft of a product with a different price was never read.

## When a price is wrong

Change the harbour decaf's page to show `$15.00` while Sanity says `$15.50`, and the test fails and says which page:

```text
  1) every product shows the checkout price

    Error: /products/harbour-decaf

    expect(locator).toHaveText(expected) failed

    Locator:  getByTestId('price')
    Expected: "$15.50"
    Received: "$15.00"
    Timeout:  1000ms
```

The loop stops at the first failure, like any Playwright test. Fix it and run again, or write one `test()` per page to see them all at once.

## A sample, for a big catalogue

Ten thousand products should not mean ten thousand page loads on every run. `content.sample(type, n)` opens `n` of them, chosen by a seeded shuffle:

```ts title=prices.spec.ts
for await (const product of content.sample("product", 25)) {
  await page.goto(product.url);
  await expect(page.getByTestId("price"), product.url).toHaveText(product.checkoutPrice);
}
```

The same seed picks the same products in the same order, so a failure can be replayed. The seed is `GAUGELINE_SEED` if you set it, otherwise today's date (UTC), so the sample changes every day and a nightly run slowly covers the catalogue. The seed is written into the test report as a `gaugeline-seed` annotation. To replay a failed run, set `GAUGELINE_SEED` to that value or pass `seed` in the options.

If `n` is larger than the number of documents, you get all of them. `n` must be a whole number of at least 1.

## It fails when there is nothing to test

A loop over nothing passes. The easiest way for this helper to lie would be a renamed document type returning an empty list and every test going green, so an empty list is an error:

```text
No published "producct" documents were found. A loop over nothing passes, so this fails instead. Check the type was not renamed, that documents of it are published (a draft is not read), and that the project, dataset and token are the ones that hold them.
```

The same happens when documents exist but none of them has an address.

## Documents with no page

A document can exist without a page: a gift card, a settings document, a product nobody has given a slug. For each document the helper needs an address to open. It uses, in order:

1. the document's `url` field (change the name with `urlField`). A path starting with `/` or a full `http(s)` address;
2. the route for its type with the slug filled in: `routes: { product: "/products/{slug}" }`. The slug can be a plain string or a Sanity `slug` field.

A document with neither is left out of the loop, and the helper tells you: it is added to `content.skipped` (`{ id, type, reason }`) and to the test report as a `gaugeline-skipped` annotation. It does not fail the test, because a document with no page is normal, and it is not silent either.

## Options

Set them for a file with `test.use({ gaugeline: { ... } })`, or for the whole suite in the `use` block of `playwright.config.ts`.

| Option         | Default                                   | What it does                                                                |
| -------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| `projectId`    | `SANITY_PROJECT_ID`                       | The Sanity project to read.                                                 |
| `dataset`      | `SANITY_DATASET`, then `production`       | The dataset to read.                                                        |
| `token`        | `SANITY_TOKEN`                            | A read-only token (Viewer role), for a private dataset.                     |
| `seed`         | `GAUGELINE_SEED`, then today's date (UTC) | Seeds `content.sample`.                                                     |
| `urlField`     | `url`                                     | The field that holds a document's address.                                  |
| `routes`       | none                                      | A path for each type that has no address field, with `{slug}` in it.        |
| `allowPrivate` | `false`                                   | Allow an absolute address on a private or loopback host (a local dev site). |
| `pageSize`     | `100`                                     | Documents asked for per request.                                            |
| `read`         | Sanity, with one GET per request          | Replace the read, for example with recorded content in your own tests.      |

An absolute address on a private, loopback, link-local or metadata host is skipped with a reason unless `allowPrivate` is set. A site on your own machine (`http://127.0.0.1:3000`) is the usual reason to set it; the relative paths in the example need none, because Playwright's `baseURL` decides where they open.

## What it reads, and what it never does

- **Read only.** The helper asks Sanity's query API for published documents. Every request is a GET, through Gaugeline's fetcher, which refuses a private, loopback, link-local or metadata address. It never writes to your dataset, never publishes, and never reads a draft.
- **A Viewer token is enough.** Create one in sanity.io/manage under API, with the Viewer role (see [Private datasets](/docs/private-datasets)). The token travels in a header and is never printed in an error, a report or the test output.
- **No browser of ours.** Gaugeline does not launch one. The pages are opened by your own Playwright, in your own test, against your own site.
- **Your content is data.** A field with text that looks like an instruction is a string in `product`, nothing more.

## What it won't do

- It reads Sanity only. Other platforms are not read by this helper.
- It tests what you write. It hands you the documents; the assertions are still yours. To check the live page against Sanity without writing tests, run `npx gaugeline`; see [Why not just use Playwright?](/docs/why-not-playwright).
