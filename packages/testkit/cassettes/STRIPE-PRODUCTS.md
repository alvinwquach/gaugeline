# Stripe cassettes

These three files were written by hand (by a script in the branch that added them), not recorded: no
Stripe account was asked. The shops, products, prices and ids are invented, and tests never contact
Stripe. Each interaction answers one request of the Stripe connector
(`packages/core/src/connectors/stripe.ts`) in the shape of Stripe's list responses
(`{ object: "list", url, has_more, data }`). The shapes are not confirmed against Stripe's current
reference (its documentation was not reachable when they were written); see the Sources of the pull
request that added this file.

- `stripe-products`: the pop-up kitchen La Olla Pop-Up. Five products on one page and eight prices on
  one page: an archived product, an archived price, a product with no default price and three prices,
  and a tiered price (`unit_amount: null`). The tamal box costs 4800 now and has an archived 4200.
- `stripe-large`: a store of 250 products on three pages (100, 100, 50) and 300 prices on three pages
  (the first 50 products have a second, archived price). Cursors are `starting_after=<last id>`.
- `stripe-no-prices`: products answer 200; prices answer 403 (a restricted key without the Prices
  permission).

No key is in any file: the connector sends its key in a request header, and a cassette never holds
request headers. Regenerate nothing by recording: edit the JSON by hand, or rebuild it with a script.
