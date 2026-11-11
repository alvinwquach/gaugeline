# hydrogen-like

An invented ceramics store that looks like a Shopify Hydrogen storefront from the outside: the
`powered-by: Shopify, Hydrogen` header, the inline `window.__reactRouterContext` script and its
streamed `streamController.enqueue(...)` chunk of loader data in turbo-stream form (the structure
`@shopify/cli-hydrogen` 13.0.6's starter writes, not copied from a site). Nothing here is a real
business or deployment. The fixture serves two hosts from these files: the store and an invented
preview deployment address (`marrowlane-preview-4f2a.o2.myshopify.dev`, never resolved outside tests).

- The canonical points at the preview address: `hydrogen-preview-canonical`.
- `/journal.html` links to that preview address, which answers 200 with no noindex:
  `hydrogen-preview-indexable` (it runs against `/journal.html`; the home page links nowhere, so the
  docs example never asks a host outside the fixture).
- The root loader data holds `privateStorefrontToken`: `hydrogen-private-fields`. The public
  `consent.storefrontAccessToken` beside it is not flagged.
- The page shows $38.00 and its embedded variant price is 38.0, but the JSON-LD offer says 36.00:
  `hydrogen-prices-disagree`.
