# Database access rules, tested from outside

Access rules are easy to get wrong and impossible to see from the page. A Supabase project's public
key is in the site's code by design, so the rules on each table are the only thing between a
visitor and the data. The honest test is to ask the database as each kind of user and see what
comes back. Gaugeline does that without reading a single row: it asks for counts.

## Setting it up

Put `gaugeline.access.json` in the folder you run Gaugeline from (it moves into the config file
when that arrives). It names the project and the environment variables that hold the keys, never
the keys themselves:

```json
{
  "provider": "supabase",
  "url": "https://<project-ref>.supabase.co",
  "anonKeyEnv": "SUPABASE_ANON_KEY",
  "tables": [
    { "name": "menu_items", "public": true },
    { "name": "orders", "owner": "customer_id" }
  ],
  "users": [
    {
      "role": "customer",
      "tokenEnv": "GAUGELINE_TEST_CUSTOMER_TOKEN",
      "userIdEnv": "GAUGELINE_TEST_CUSTOMER_ID"
    }
  ]
}
```

- `tables`: mark the ones meant to be readable by anyone with `public`, and give `owner` (the
  column holding the owner's user id) for tables whose rows belong to one user.
- `users`: optional test users. For each, an access token for a test account you made for this,
  and that account's user id. Gaugeline doesn't sign in: it only sends the token you give it.
- A variable the file names but the environment lacks stops the run (exit 2), naming the variable.

Gaugeline is read-only, so there is no way to turn on write probes: `"probeWrites": true` is refused.

## What it asks

All through the fetcher, `GET` and `HEAD` only:

1. `GET /rest/v1/` with the public key: the project's API description, which lists the exposed
   tables and views and their column names.
2. For each table (at most 20), `HEAD /rest/v1/<table>?select=*` with `Prefer: count=exact`, as an
   anonymous visitor. The answer has a status and a count in `Content-Range`, and no rows.
3. For each test user and each table with an `owner`, the same `HEAD` with that user's token and
   `<owner>=neq.<their id>`: how many rows that aren't theirs they can read.

Keys and tokens go only in the `apikey` and `Authorization` headers. They never appear in an
address, a finding, a log line or a report.

## The checks

- `access-public-read`: a table or view anyone can read, with rows in it, that you didn't mark
  `public`. The evidence names the table, the count and the column names.
- `access-role-scope`: a signed-in test user can read rows that belong to someone else.

A table that answers with 0 rows is not reported: an open, empty table looks exactly like one whose
rules hide every row. A view is read like a table and named as a view (views skip row level
security unless they are made with `security_invoker`).

## Example

Against the invented `access-rules` fixture, a lunch counter whose orders table was left open,
with the project's answers replayed from an invented recording, version 0.1.0 prints:

```text title=Output
✗ Anyone can read a table you didn't make public
    order_totals (a view): 7 rows readable without signing in; columns: day, orders, revenue
✗ Anyone can read a table you didn't make public
    orders: 42 rows readable without signing in; columns: id, created_at, customer_id, customer_email, total
✗ A signed-in user can read other people's rows
    as customer, orders: 3 rows whose customer_id is someone else's are readable; columns: id, created_at, customer_id, customer_email, total
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 1 image, 1 sitemap page, all 5 database tables.
3 to look at, 3 to fix first.
```

The tables were read as an anonymous visitor and as the `customer` test user. `menu_items` is
readable too, and passes because it is marked `public`; `newsletter` answered with 0 rows and
`profiles` refused. Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/access.test.ts`, with placeholder keys and the project answered from
`packages/testkit/cassettes/supabase-access.json`, never the live service.
