# Shopify Hydrogen sites

A ceramics shop, a pop-up bakery or a physio clinic's merch store built on Shopify Hydrogen (React
Router 7, hosted on Oxygen) has a few quiet failures of its own: a preview deployment that is open to
search engines, a product whose price differs between what the shopper sees and what Google reads,
and loader data that sends more to the browser than the page shows. These checks look at that, using
only what the store already serves to every visitor.

## How a Hydrogen storefront is recognised

From its responses: the `powered-by: Shopify, Hydrogen` header Hydrogen's request context sets on
every response, or the `window.__reactRouterContext` (or, on older Hydrogen, `window.__remixContext`)
the page embeds for the browser on a page that also loads Shopify's CDN. On any other site the
checks below are not run.

## The checks

- `hydrogen-preview-canonical` (fix first): the canonical address, `og:url`, `og:image` or a sitemap
  entry of a production page is on a preview host (`myshopify.dev`, `o2.myshopify.dev`, `vercel.app`,
  `netlify.app`, `pages.dev`).
- `hydrogen-preview-indexable` (fix first): a preview deployment that the site itself reveals (a link
  or a sitemap entry on a production page, or the page being checked when it is itself a preview)
  answers a plain `GET` with a page and no `noindex`, in `X-Robots-Tag` or a robots meta tag. A
  sign-in page, 401, 403 or 404 is not a finding. One request per revealed address, at most the run's
  limit for hidden pages; no other path on that host is asked for.
- `hydrogen-prices-disagree` (fix first): on a product page, the price shown, the price in the page's
  structured data (the JSON-LD offer, `product:price:amount` or `og:price:amount`) and the variant
  price in the page's own embedded state (`product.selectedOrFirstAvailableVariant.price`) are not
  all the same, or are in different currencies. Amounts are integers in minor units with the
  currency's own exponent (a yen has none, a Bahraini dinar three), never floats, and currencies are
  compared, never converted. A compare-at price is left out.
- `hydrogen-private-fields` (fix first): the state embedded in the page, including the first
  streamed chunk of loader data, has fields named like something private (`password`, `secret`,
  `privateStorefrontToken`, `apiKey`, `internalNotes` and a few more, matched by word). **Names
  only, never values.** The public Storefront API token and the checkout domain, which the starter's
  root loader sends on purpose, are not flagged.
- `hydrogen-dev-tools-live` (fix first): the page was served by the dev server (it loads
  `/@vite/client`, `/@react-refresh` or the `inject-hmr-runtime` module). Only a page recognised as
  Hydrogen (see above) is reported here; a React Router 7 site that is not Hydrogen is reported by
  `remix-dev-tools-live` instead, so one dev server is reported once.

## What is not checked, and why

- **The price at checkout.** Whether the price a cart or checkout would charge matches the product
  page needs a cart, and creating one is a write. Gaugeline is read only and does not do it, and the
  Storefront API only answers `POST`. Every product page where prices were read says so under "could
  not run". Gaugeline does compare the three prices the page already serves.
- **Draft or preview mode.** Hydrogen has no draft mode of its own, so there is no preview route to
  ask for.
- **Data addresses.** Hydrogen is React Router 7: the route data behind a page is at `<page>.data`.
  The Remix and React Router checks cover that; this pack does not ask for it.

When the state cannot be read (cut by the size limit, a truncated page, a stream that is not
turbo-stream, or deferred values after the first chunk) the check says it could not check, with the
reason; it does not pass the page.

## Example

Against the invented `hydrogen-like` fixture, a ceramics store whose canonical address still points
at a preview deployment, and whose product data says 36.00 where the page says 38.00:

<!-- fixture: hydrogen-like -->

```sh title=Terminal
$ npx gaugeline marrowlane-ceramics.example
```

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="http://marrowlane-preview-4f2a.o2.myshopify.dev/"> on https://marrowlane-ceramics.example/ (differs by host, port)
✗ The live Hydrogen store points search engines at a preview deployment
    canonical http://marrowlane-preview-4f2a.o2.myshopify.dev/ is on a preview domain
✗ This Hydrogen product's prices disagree
    the page shows 38.00 but the product data 36.00 USD
✗ The data sent with a Hydrogen page has fields that look private
    __reactRouterContext has privateStorefrontToken (field names only)
? hydrogen-prices-disagree could not be checked: the price a cart or checkout would charge is not compared: that needs a cart, which Gaugeline will not create (/)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

4 to look at, 4 to fix first.
```

`canonical-elsewhere` reports the same canonical from the search side. Each check that passed also
prints a `✓ <id>` line, left out above. The fixture's `/journal.html` links to the preview address,
which is what `hydrogen-preview-indexable` follows; the home page above links nowhere, so the example
asks no other host.

## What was looked up

Every header and marker comes from the installed packages, read on 11 November 2026
(`@shopify/hydrogen` 2026.10.3 and `@shopify/cli-hydrogen` 13.0.6, from npm), because `shopify.dev`
was not reachable from the build machine and no live store was reachable to look at. The fixtures
are invented and reproduce the structure that source writes.

- `powered-by: Shopify, Hydrogen` on every response: `@shopify/hydrogen` `dist/core/request-context.mjs`
  (`applyResponseHeaders`).
- The starter's root loader returns `consent: { checkoutDomain, storefrontAccessToken }` (public by
  design; `PRIVATE_STOREFRONT_API_TOKEN` and `SESSION_SECRET` are the server-only variables), and its
  product route returns `product.selectedOrFirstAvailableVariant.price` shown by `<Money>` inside
  `<div aria-label="Price" class="product-price">`: `@shopify/cli-hydrogen` `dist/assets/hydrogen/starter`.
- The robots.txt route the starter ships returns the same rules on every deployment; the
  `hydrogen-robots-txt` skill in the `@shopify/hydrogen` package says Hydrogen ships no helper for it.
  Neither sets `noindex` for a preview deployment.
- Preview deployments are visible only to signed-in staff until a shared link is created (a
  search-result summary of Shopify's "Manage Oxygen deployments" page; the page itself was not
  reachable).

Uncited, and said so in each check's technical line: the preview host suffixes `myshopify.dev` and
`o2.myshopify.dev` (the owner's note; no document read names a preview host), the JSON-LD and meta
tag names as used on Hydrogen stores (they are schema.org and Open Graph conventions), and the
words that mark a field name as private.
