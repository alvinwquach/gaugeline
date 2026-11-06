# access-rules

An invented lunch counter whose `gaugeline.access.json` points at an invented Supabase project,
`gaugelinefixture`. Its answers are hand-written in the `supabase-access` cassette
(packages/testkit): counts in `Content-Range` and an API description with column names, never row
values. Nothing here is a real business, project or key.

- `menu_items` (12 rows) is readable by anyone and is configured as public: no finding.
- `orders` (42 rows) and the `order_totals` view (7 rows) are readable by anyone: `access-public-read`.
- `newsletter` is readable but empty: no finding, since an open empty table can't be told from one
  whose rules hide every row.
- `profiles` refuses anonymous reads (401).
- Signed in as the test customer, 3 orders with someone else's `customer_id` are readable:
  `access-role-scope`.

The tests set the three variables the file names to placeholder values. The fixture is not in the
built-bin run (all-checks-fire), which can't reach the recorded project; both checks are confirmed
in-process.
