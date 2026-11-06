# Supabase access cassette

`supabase-access.json` was written by hand, not recorded. The projects, tables, columns and counts
are invented, so no real project is in the repository, and tests never ask Supabase.

It answers the requests the access checks make (packages/core/src/access/probe.ts): the PostgREST
API description (`GET /rest/v1/`, column names only) and one `HEAD` per table with a count in
`Content-Range`. No answer carries a row.

- `gaugelinefixture`: `menu_items` 12 rows, `newsletter` 0, the `order_totals` view 7, `orders` 42,
  `profiles` refused (401); as the test customer, 3 orders with another `customer_id`.
- `gaugelinequiet`: exposes no tables.

The requests carry placeholder keys in headers; a cassette stores the address and the answer only.
