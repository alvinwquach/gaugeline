# Sanity products cassette

`sanity-products.json` was written by hand (by a script in the branch that added it), not recorded.
The projects, datasets, products and answers are invented, so no real dataset is in the repository,
and tests never ask Sanity.

Each interaction answers one request of the Sanity connector (`packages/core/src/connectors/sanity.ts`),
in the shape of Sanity's query API (`{ ms, query, result }`). The shapes are not confirmed against
Sanity's current reference; see the Sources of the pull request that added this file.

- `ember8kc/production`: a public dataset of a pop-up kitchen. The default products query returns five
  products (prices as `45`, `"48.00"`, `19.99`, `null` and `0`); five custom queries return menu items
  with or without `sku`, `name`, `_id` and `price`; the type names (`menuItem`, `product`,
  `siteSettings`) and their counts; and a malformed query that answers 400. `ember8kc/staging` has one product.
- `pr1v4te0/production`: a private dataset that answers 401 without a token (products and type names).
- `v1ewert0/production`: a private dataset read with a token whose user has the `viewer` role.
- `wr1ter00/production`: the same, with a token whose user has the `editor` role.
- `b4dt0ken/production`: a token Sanity does not accept (401).
- `r4t3l1m1/production`: a 429 with `Retry-After: 30`.

Regenerate nothing by recording: edit the JSON by hand, or rebuild it with a script that imports
`productsUrl` so the addresses match the connector's.
