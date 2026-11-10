# Printful cassettes

These two files were written by hand (by a script in the branch that added them), not recorded: no
Printful account was asked. The store, products, variants, prices and ids are invented, and tests
never contact Printful. Each interaction answers one request of the Printful connector
(`packages/core/src/connectors/printful.ts`) in the shape of Printful's store product responses
(`{ code, result, paging }` for the list; `{ code, result: { sync_product, sync_variants } }` for one
product). The shapes are not confirmed against Printful's current reference (its documentation was not
reachable when they were written); see the Sources of the pull request that added this file.

- `printful-merch`: Ridgeline Strength Coaching, a coach's merch store. Five products on one list
  page: a logo tee (three sizes), a training hoodie (the large is not synced and costs 58.50 where the
  medium costs 54.00), a water bottle (an empty retail price and an empty SKU), a tote bag (a price
  sent as "24.5") and a draft poster with no variants and no external id.
- `printful-large`: 45 products on three list pages of 20 (the connector asks for 100; the shop holds
  back 20), each with one variant. Used to prove the request count and that no more than five detail
  requests are in flight.

No token is in any file: the connector sends its token and store number in request headers, and a
cassette never holds request headers. Regenerate nothing by recording: edit the JSON by hand, or
rebuild it with a script.
