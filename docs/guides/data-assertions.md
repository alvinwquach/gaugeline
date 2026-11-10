# Data assertions: a SELECT that should return nothing

Available from version 0.2.0.

Some problems never show on a page until a customer runs into them: two private events booked in one
room on the same night, an order marked paid that has no payment behind it, a product on sale twice.
Every page looks fine. The mistake is in the rows.

A data assertion is a `SELECT` that should return **zero rows**. You write the query that finds the
mistake, and Gaugeline runs it on every check. No rows means the data is fine. Any rows are a
finding, with the count and the first few rows to start from. If you know SQL, you already know how
to write one, and there is nothing else to learn. It is the same rule dbt's data tests use: a test is
a query for the rows that should not exist.

Assertions only read. They run through [the read-only database source](/docs/connectors/postgres),
so a query that could change anything is refused before it is sent, and every one runs inside a
read-only transaction with a time limit. Run them only against a database you own or have permission
to read.

## Example: the BUCK Tavern's bookings

The BUCK Tavern (invented, like every business on this page) takes private-event bookings through a
Next.js site on Vercel, and the bookings live in a Supabase project. Two events were once booked in
the Loft on the same night, and nobody found out until the second party arrived. The freelancer who
built the site writes the rule down once, so that cannot happen quietly again.

**1. A role that can only read.** Make the `gaugeline_reader` role from
[the database source page](/docs/connectors/postgres),
and give it `select` on the two tables below. Everything else on this page is a second lock on the
same door.

**2. Write the assertions.** They go in `gaugeline.sources.json`, next to the source they run on. The
file holds names and SQL, never a password: the connection string stays in the environment variable
it names.

```json title="gaugeline.sources.json"
{
  "sources": {
    "db": { "type": "supabase", "env": "BUCK_SUPABASE_DB_URL" }
  },
  "assertions": [
    {
      "id": "no-overlapping-bookings",
      "severity": "high",
      "title": "Two private events are booked at the same time",
      "sql": "select a.id as booking_id, b.id as clashes_with, a.room, a.starts_at from private_events a join private_events b on a.room = b.room and a.id < b.id and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at) order by a.starts_at, a.id",
      "evidence": ["booking_id", "clashes_with", "room", "starts_at"]
    },
    {
      "id": "no-open-holds-past-expiry",
      "severity": "medium",
      "title": "A table hold is still open after it ran out",
      "sql": "select id as hold_id, party_size, expires_at from table_holds where status = 'open' and expires_at < now() - interval '15 minutes' order by expires_at, id",
      "evidence": ["hold_id", "party_size", "expires_at"]
    }
  ]
}
```

The first query joins the table to itself and uses Postgres's range type: `tstzrange(start, end)`
makes a time range, and `&&` asks whether two ranges overlap. Back-to-back events do not overlap,
because a range does not include its end. The `evidence` list is the columns a finding may print.
Notice what it leaves out: the guest's name and email are in the table, and they never leave the
database.

**3. See what is set up.** `--list` prints the assertions and runs none of them, so it needs no
database:

```sh title=Terminal untested="Needs a database. packages/cli/src/__tests__/assertions-docs.test.ts runs this page's commands against a stand-in Postgres and compares the output."
$ npx gaugeline assert --list
```

```text title=Output
2 data assertions in gaugeline.sources.json:

  no-overlapping-bookings    high    db  Two private events are booked at the same time
  no-open-holds-past-expiry  medium  db  A table hold is still open after it ran out
```

**4. Run one.** The Loft has two events that clash tonight, so the first assertion fails and
`gaugeline assert` exits 1:

```sh title=Terminal untested="Needs a database. packages/cli/src/__tests__/assertions-docs.test.ts runs this page's commands against a stand-in Postgres and compares the output."
$ npx gaugeline assert no-overlapping-bookings
```

```text title=Output
✗ Two private events are booked at the same time
    no-overlapping-bookings: 1 row. booking_id=41, clashes_with=42, room=Loft, starts_at=2026-12-05T19:00:00.000Z
```

The second assertion passes, which looks like this:

```sh title=Terminal untested="Needs a database. packages/cli/src/__tests__/assertions-docs.test.ts runs this page's commands against a stand-in Postgres and compares the output."
$ npx gaugeline assert no-open-holds-past-expiry
```

```text title=Output
✓ no-open-holds-past-expiry: no rows, so it passes
```

**5. In every check.** You do not have to run them by hand. When `gaugeline.sources.json` has
assertions, a normal check of the site runs all of them, once, and each one
that fails is a finding of the check `data-assertion-failed`, with the severity and the title you
wrote:

```sh title=Terminal untested="Needs a database. packages/cli/src/__tests__/assertions-docs.test.ts runs this page's commands against a stand-in Postgres and compares the output."
$ npx gaugeline buck.example
```

```text title="Output (the lines from the database)"
✗ Two private events are booked at the same time
    no-overlapping-bookings: 1 row. booking_id=41, clashes_with=42, room=Loft, starts_at=2026-12-05T19:00:00.000Z
```

An assertion that could not run (the database is down, the query ran out of time, the role is not
allowed to read a table) is listed under "could not check". It is never a pass.

## More examples from client work

Each of these is a folder in [`examples/assertions`](https://github.com/alvinwquach/gaugeline/tree/main/examples/assertions)
with the assertion, a fixture schema, one seed that passes it and one that fails it. All of them are
invented, and each is run in CI against a real Postgres server, once with each seed.

| Shape                   | The rule                                       | From client work                                                |
| ----------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `overlapping-ranges`    | No two events in one room at the same time     | The BUCK Tavern's private events                                |
| `orphaned-foreign-keys` | Every paid order has a payment that matches it | Lula's Kitchen, whose card processor writes payments by webhook |
| `duplicate-natural-key` | No two products on sale with the same slug     | Bring The Shreds, whose catalogue is imported from a supplier   |
| `rows-past-expiry`      | No table hold stays open after it expired      | The BUCK Tavern's holds, closed by a job that sometimes stops   |
| `totals-dont-add-up`    | An order's total is the sum of its lines       | Lula's Kitchen, after someone edited a quantity by hand         |

Lula's Kitchen's rule, "no paid order without a match", is a left join that keeps the orders with no
payment row:

```sql title="Orders marked paid that have no payment"
select o.id as order_id,
       o.total_cents,
       o.placed_at
from orders o
left join payments p on p.order_id = o.id
where o.status = 'paid'
  and p.id is null
order by o.placed_at, o.id
```

and Bring The Shreds' "no product without a Stripe price" is the shortest assertion there is:

```sql title="Active products with no Stripe price"
select id as product_id, slug
from products
where active
  and stripe_price_id is null
order by id
```

## Writing one

- **One `SELECT`** (or `WITH ... SELECT`). The query finds the rows that **break** the rule, so a clean
  database returns none. Gaugeline checks the statement before it sends it; see
  [the three read-only layers](/docs/connectors/postgres#the-three-read-only-layers).
- **Name every column you want to show with `as`**, and list those names in `evidence`. A column that
  is not in `evidence` is dropped as soon as it is read: an email or a phone number is shown only
  because you listed it.
- **Order the rows** so the first ones are the ones to look at first, and the findings read the same
  from one run to the next.
- **Keep it cheap.** A query has 5 seconds by default (`timeoutMs` on the source changes it, up to 60)
  and Gaugeline reads at most 5,000 rows of it. A query that does more is reported as "could not
  check".
- **Say what is wrong in the title**, in a sentence for the person who owns the business. It is the
  title of the finding.

| Field      | Meaning                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| `id`       | Lower-case words joined by hyphens, like `no-overlapping-bookings`. Unique in the file. |
| `severity` | `high` (fix this first), `medium` (fix soon) or `low` (worth knowing).                  |
| `title`    | What is wrong, in plain words. At most 140 characters.                                  |
| `sql`      | The `SELECT`. At most 20,000 characters.                                                |
| `evidence` | The result columns a finding may show: at least one, at most ten, each named once.      |
| `source`   | The source to run it on. Needed only when the file has more than one source.            |

A source that only runs assertions needs no `queries`. At most 100 assertions per file.

## What a finding shows

One finding per failing assertion. It names the assertion, says how many rows broke it, and lists the
evidence columns of the first 20 rows. Fifty rows look like this:

```text
no-overlapping-bookings: 50 rows, showing the first 20. booking_id=1, clashes_with=2, room=Loft, starts_at=2026-12-05T19:00:00.000Z; booking_id=3, ...
```

A finding has to be readable in ten seconds: the count says how big the problem is and the first rows
say where to start. If the query had more than 5,000 rows (or the lower `maxRows` you set on the
source), the count reads "more than 5,000 rows".

What you see is data, never instructions. Control and invisible characters are shown as `\u{200B}`
and the like, a long value is cut at 80 characters, and a connection string, password or key that
somehow ended up in a cell is replaced with `[redacted]`.

Because the evidence is the finding's identity from one run to the next, a different set of rows
counts as a new finding in a baseline or the weekly digest. That is usually what you want: it is a
different booking.

## When something is wrong with the file

| What happened                                                | What you see                                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| The SQL is not one plain read                                | Exit 2 before anything is requested: `assertion "x" is not a read and was not run. DELETE changes data...`. It is never sent to any database. |
| An id is used twice, or names an unknown source              | Exit 2, naming the assertion.                                                                                                                 |
| An evidence column is not in the result                      | Exit 2, naming the column and listing the ones the query returns. In a normal check it comes after the report.                                |
| The database cannot be reached, or the query ran out of time | "Could not check", naming the assertion and what to change. Never a pass.                                                                     |

A query that returns no rows cannot show which columns it has, so a wrong evidence column in an
assertion that currently passes is noticed the first time it returns rows. Run it once against a
copy of the data that breaks the rule, as the examples folder does, to be sure.

## Commands

| Command                   | What it does                                                           | Exit                               |
| ------------------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| `gaugeline assert --list` | Prints the assertions: id, severity, source, title. Runs none.         | 0                                  |
| `gaugeline assert <id>`   | Runs one assertion and prints the result.                              | 0 no rows, 1 rows, 2 could not run |
| `gaugeline <address>`     | Runs every assertion as part of the check, as `data-assertion-failed`. | as for any check                   |

The connection string is read from the environment variable the source names (`env`, or
`GAUGELINE_POSTGRES_URL` and `GAUGELINE_SUPABASE_DB_URL` by default), never from a flag.
