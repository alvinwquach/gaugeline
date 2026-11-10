# Shopify and Square cassettes

These four files were written by hand (by a script in the branch that added them), not recorded: no
Shopify store and no Square account was asked. The shop, products, variants, prices, ids and tokens
are invented, and tests never contact Shopify or Square. Each interaction answers one request of the
Shopify connector (`packages/core/src/connectors/shopify.ts`) or the Square connector
(`packages/core/src/connectors/square.ts`) in the shape of the REST Admin API (`products.json`,
`shop.json`, `oauth/access_scopes.json`, with the next page in a `Link` header) and of the Catalog API
list (`objects` and `cursor`). The shapes are not confirmed against Shopify's or Square's current
reference (their documentation was not reachable when they were written); see the Sources of the pull
request that added this file.

- `shopify-shop` and `square-shop`: Ridgeline Strength Coaching, a coach's shop, the same four things
  on each. A training hoodie in three sizes (54.00, 54.00 and 58.50 for the large; on Shopify the
  large is sold out), a month pass (120.00; on Shopify not tracked), an intro session (0.00, a free
  item; on Shopify oversold and still on sale) and a winter challenge (35.00, archived). Two pages
  each: Shopify by `Link` header, Square by `cursor`. The page-against-provider test compares the same
  shop page with both.
- `shopify-large` and `square-large`: one product with forty variants (SKUs RL-KIT-01 to RL-KIT-40),
  to prove a product with many variants comes back whole.

No token is in any file: the connectors send theirs in request headers, and a cassette never holds
request headers. Regenerate nothing by recording: edit the JSON by hand, or rebuild it with a script.
