# hydrogen-like

An invented ceramics store that looks like a Shopify Hydrogen storefront from the outside: the
`powered-by: Shopify, Hydrogen` header, the inline `window.__reactRouterContext` script and its
streamed `streamController.enqueue(...)` chunk of loader data in turbo-stream form (the structure
`@shopify/cli-hydrogen` 13.0.6's starter writes, not copied from a site). Nothing here is a real
business or deployment.

- The canonical points at the preview address: `hydrogen-preview-canonical`.
- `hydrogen-preview-indexable` has its own fixture, `hydrogen-preview-link`: this page links to no
  other host, so the docs example never asks one.
- The root loader data holds `privateStorefrontToken`: `hydrogen-private-fields`. The public
  `consent.storefrontAccessToken` beside it is not flagged.
- The page shows $38.00 and its embedded variant price is 38.0, but the JSON-LD offer says 36.00:
  `hydrogen-prices-disagree`.
