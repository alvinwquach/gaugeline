# A database as a source: Postgres and Supabase

Available from version 0.2.0.

Some of a small business's truth is not on its website. The bar's 86 list (what is sold out tonight),
its bookings, a pop-up's remaining tickets and a clinic's open slots live in a database, and the site
shows a copy. When the two disagree, a customer books a table that is not there or orders a drink
that is gone.

This connector lets Gaugeline read named queries from a Postgres database, or from a Supabase
project's database, so checks can compare the page with the rows. It reads. It cannot write, and it
is built so that a mistake in one safeguard is caught by another. Run it only against a database you
own or have permission to read: Gaugeline connects with the connection string you give it and nothing
else.

Two checks use it. [Data assertions](/docs/guides/data-assertions) are `SELECT`s that should return
no rows, run on every check. [Switches, sold out and capacity](/docs/guides/switches-and-availability)
compare a page with a named query: the bar's 86 list against the menu, the number of dishes left
against the order page. `gaugeline.sources.json` is validated on every run, so a typo is caught now.

## Example: the bar's 86 list and bookings in Supabase

The BUCK Tavern (invented, like every business on this page) has a Next.js site on Vercel. The
bookings and the 86 list are in a Supabase project, and the menu page shows prices. The freelancer
who built it wants to know, on every run, which drinks the database says are gone and which large
parties are booked.

**1. Make a role that can only read.** In Supabase this is the SQL editor. This is the real boundary:
everything else on this page is a second and third lock on the same door.

```sql title="Read-only role"
create role gaugeline_reader login password 'choose-a-long-password';
alter role gaugeline_reader set default_transaction_read_only = on;
alter role gaugeline_reader set statement_timeout = '10s';
grant usage on schema public to gaugeline_reader;
grant select on public.menu_items, public.bookings to gaugeline_reader;
-- Only for tables that have row-level security switched on: without a policy the role sees no rows.
create policy gaugeline_read on public.menu_items for select to gaugeline_reader using (true);
create policy gaugeline_read on public.bookings for select to gaugeline_reader using (true);
```

**2. Name the queries.** `gaugeline.sources.json` sits next to the site's other Gaugeline files. It
holds names and SQL, never a password:

```json title="gaugeline.sources.json"
{
  "sources": {
    "db": {
      "type": "supabase",
      "env": "BUCK_SUPABASE_DB_URL",
      "keyEnv": "BUCK_SUPABASE_ANON_KEY",
      "queries": {
        "eightySixed": "select name from menu_items where is_86 = true order by name",
        "groupBookings": "select name, party_size from bookings where party_size >= 8 and booked_for >= now() order by booked_for",
        "prices": {
          "sql": "select name, price_cents from menu_items where not is_86 order by name",
          "fact": {
            "kind": "price",
            "item": "name",
            "value": "price_cents",
            "mustAppearOn": ["/menu"]
          }
        }
      }
    }
  }
}
```

**3. Set the connection string in the environment.** Copy it from Supabase (Project settings, Database,
Connection string), with the `gaugeline_reader` user and its password. The two variables are named in
the file above; the file never holds their values. Set them in your shell, your CI's secrets or a
`.env` file that is not committed. There is no flag for them, so they never end up in shell history or
a process list.

**4. What Gaugeline reads.** Each named query becomes one entry, in the order of the file. Values are
plain data: text, numbers, true or false, null, and times as ISO text.

```json title="Queries"
[
  {
    "source": "db",
    "query": "eightySixed",
    "status": "ok",
    "columns": ["name"],
    "rows": [
      {
        "name": "Negroni"
      },
      {
        "name": "Paloma"
      }
    ],
    "truncated": false
  },
  {
    "source": "db",
    "query": "groupBookings",
    "status": "ok",
    "columns": ["name", "party_size"],
    "rows": [
      {
        "name": "Okafor party",
        "party_size": 12
      },
      {
        "name": "Ng birthday",
        "party_size": 9
      }
    ],
    "truncated": false
  },
  {
    "source": "db",
    "query": "prices",
    "status": "ok",
    "columns": ["name", "price_cents"],
    "rows": [
      {
        "name": "Mezcal Mule",
        "price_cents": 1250
      },
      {
        "name": "Old Fashioned",
        "price_cents": 1500
      }
    ],
    "truncated": false
  }
]
```

A query with a `fact` mapping also becomes facts in the same model `gaugeline.facts.json` uses
(prices are kept as whole cents until they are written out), so a check can read the database the way
it reads declared facts:

```json title="Facts"
[
  {
    "id": "db.prices.1",
    "kind": "price",
    "item": "Mezcal Mule",
    "value": "$12.50",
    "mustAppearOn": ["/menu"]
  },
  {
    "id": "db.prices.2",
    "kind": "price",
    "item": "Old Fashioned",
    "value": "$15.00",
    "mustAppearOn": ["/menu"]
  }
]
```

Whoever owns the database decides what Gaugeline may read: a check asks for a query by name and
cannot write SQL of its own.

## The three read-only layers

Each layer works without the others, and each has its own tests, so a bug in one is caught even when
the others still hold.

| Layer                  | What it does                                                                                                      | What it stops                                                  | What it cannot see                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1. The statement check | Reads every query before it is sent and allows exactly one `SELECT` (or `WITH ... SELECT`).                       | Honest mistakes and clever ones, with a message that says why. | A function you wrote yourself that writes inside a `SELECT`.       |
| 2. A read-only session | Every query runs inside `BEGIN READ ONLY` with a statement timeout, as a single statement, and is rolled back.    | Anything that writes to a table, even if layer 1 missed it.    | Functions that act without writing a table (see below).            |
| 3. A role and a key    | A role that can only `SELECT`, with `default_transaction_read_only` on; a Supabase `service_role` key is refused. | Everything, at the database, whatever Gaugeline does.          | Nothing here. This is the layer that does not depend on Gaugeline. |

**Layer 1: the statement check.** A query is refused, before any connection is made, when it:

- is empty, longer than 20,000 characters, or is more than one statement (a second statement after a
  `;`, however it is hidden behind comments, strings or odd spacing);
- does not start with `SELECT` or `WITH`;
- contains `INSERT`, `UPDATE`, `DELETE`, `MERGE` or `TRUNCATE` anywhere, which includes a
  data-modifying `WITH` that starts like a read;
- contains `INTO` (`SELECT ... INTO` creates a table) or a locking clause (`FOR UPDATE`, `FOR SHARE`,
  `FOR NO KEY UPDATE`, `FOR KEY SHARE`);
- uses a `$1` parameter or a `U&` escape (they can spell a name the list would miss);
- calls a function on the deny list below, however it is written (`SET_CONFIG`, `"set_config"`,
  `pg_catalog.set_config`, `set_config/**/(...)`).

It reads text the way Postgres does: comments (including nested ones), quoted names, `'...'` strings,
`E'...'` strings and `$$...$$` strings are skipped, so a word inside one is not a keyword and a `;`
inside one is not the end of a statement. A refused query is reported as "could not check" with the
reason, and the other queries still run. It is strict on purpose: a column called `update` or `set` is
refused until you write it in double quotes.

The functions refused by default (a trailing `*` means "every name that starts with this"):

| Why                                    | Functions                                                                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop or reconfigure the server         | `pg_terminate_backend`, `pg_cancel_backend`, `pg_reload_conf`, `pg_rotate_logfile`, `set_config`, `pg_stat_reset*`, `pg_log_backend_memory_contexts`                                                        |
| Large objects and the server's files   | `lo_*`, `lowrite`, `loread`, `pg_read_*`, `pg_ls_*`, `pg_stat_file`                                                                                                                                         |
| Waiting, locks, sequences and messages | `pg_sleep`, `pg_sleep_for`, `pg_sleep_until`, `pg_advisory*`, `pg_try_advisory*`, `nextval`, `setval`, `pg_notify`, `pg_logical_emit_message`                                                               |
| Other connections, queries from text   | `dblink*`, `query_to_xml*`, `table_to_xml*`, `cursor_to_xml`, `schema_to_xml*`, `database_to_xml*`, `ts_stat`                                                                                               |
| Backups, replication, extensions       | `pg_create_*`, `pg_drop_*`, `pg_switch_*`, `pg_promote`, `pg_start_backup`, `pg_stop_backup`, `pg_backup_*`, `pg_wal_replay_*`, `pg_replication_*`, `pg_import_*`, `pg_extension_config_dump`, `pg_prewarm` |

Add your own with `denyFunctions` in the source (a function that logs a visit, say). The built-in list
cannot be shortened.

**Layer 2: a read-only session.** Each query gets its own transaction: `BEGIN READ ONLY`, then
`SET LOCAL statement_timeout` (5 seconds unless `timeoutMs` says otherwise, at most 60), then a check
that the server really reports the transaction as read only (a connection pooler can swallow the
mode; if it did, nothing is read), then the query as one statement, then `ROLLBACK`. Nothing is ever
committed. The result is read in a window of 5,001 rows, so a huge table is never pulled across the
network. If a query runs out of time, that query is "could not check" and the rest of the run goes on.

This layer stops every write to a table. It does not stop everything: tested on PostgreSQL 16, a
read-only transaction still lets `set_config`, `pg_notify`, `pg_sleep`, advisory locks,
`pg_terminate_backend` and `COPY ... TO PROGRAM` run, and a superuser can still read server files.
That is why layer 1 refuses those functions and why layer 3 exists.

**Layer 3: the role.** A role that can only `SELECT` the tables the queries read, with
`default_transaction_read_only` on, is the one safeguard that holds whatever any software does. Make
the role in step 1 above. When Gaugeline connects as a role that can write or bypass row-level
security, it still reads, and it adds a notice that says so.

## Supabase: which key, which role

Written from memory of Supabase's documentation, which could not be reached while this page was
written, so check it against the current API keys and Database pages before relying on it.

- Supabase gives every project two JWT keys. The **anon** key (called the publishable key in newer
  projects) acts as the `anon` role and obeys row-level security; it is meant to sit in a browser. The
  **service_role** key (the secret key in newer projects) bypasses row-level security completely and
  must never leave a server.
- **Gaugeline refuses a service_role key** (and a `sb_secret_` key): it decodes the key's `role` claim
  on your machine, never sends the key anywhere and never prints it. If you set one, the run says so
  and reads nothing.
- Gaugeline runs SQL, and Supabase's REST API does not run SQL, so it connects to the project's
  Postgres database with a connection string, as a role. The key is optional: set it (the anon key, or
  a key for a role you made) and Gaugeline checks it is not a service_role key, which stops a
  copy-and-paste mistake. It is a guard, not a way in.
- For the same reason a `supabase` source refuses to connect as `postgres`, `service_role`,
  `supabase_admin`, `supabase_auth_admin` or `supabase_storage_admin`, which read around row-level
  security. Use `gaugeline_reader`. A pooler address spells the user `gaugeline_reader.<project ref>`.
- Use the **session** pooler or the direct connection. The transaction pooler can swallow the
  read-only mode, which Gaugeline checks and refuses.
- Add a row-level security policy for the role on each table that has security switched on (the
  `create policy` lines above), or the role sees no rows and the query returns nothing.

## Settings and environment

`type` is `postgres` or `supabase`. The names of the variables are the only thing the file says about
the connection.

| Setting             | Meaning                                                                                | Default                                                                             |
| ------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `env`               | The name of the variable that holds the connection string.                             | `GAUGELINE_POSTGRES_URL`, or `GAUGELINE_SUPABASE_DB_URL`                            |
| `keyEnv` (supabase) | The name of the variable that holds the anon (or custom role) key, if you set one.     | `GAUGELINE_SUPABASE_KEY`                                                            |
| `timeoutMs`         | How long a query may run before the database stops it (100 to 60,000).                 | 5000                                                                                |
| `maxRows`           | Rows kept per query. It can lower the cap, not raise it.                               | 5000                                                                                |
| `denyFunctions`     | More function names to refuse, added to the built-in list.                             | none                                                                                |
| `queries`           | Named queries: `"name": "select ..."`, or `"name": { "sql": "...", "fact": { ... } }`. | at most 50 per source, at most 5 sources (a source with only assertions needs none) |

The connection string is `postgres://user:password@host:5432/database`, with `?sslmode=` if you need
it. Connections away from this machine use TLS unless the string says `sslmode=disable`; a local
database does not. The string may carry `sslmode` and `pgbouncer` only: any other parameter is refused,
because `options=` could switch the read-only mode off. The `PG*` variables the `psql` command reads
(`PGHOST`, `PGPASSWORD`, ...) are never read. A link-local address (where cloud metadata services live)
is refused.

The rows of a query that has a `fact` become facts. `kind: "price"` takes `item` and `value` (the
names of columns), `unit` (`minor` for whole cents, the default, or `major` for dollars) and
`currency` (default `$`); `kind: "text"` takes `value`. Both take `mustAppearOn`, a list of paths.
A row with an empty value, or a price that is not a plain amount, is skipped with a notice.

## When something goes wrong

Every failure is one sentence that says what to change, and none contains the password or the key:

| What happened                                   | What Gaugeline says                                                                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| The variable is not set                         | `db:db is not set up, so it was left out. Set GAUGELINE_POSTGRES_URL to include it.`                                                           |
| Nothing is listening                            | `Could not connect to the database at host:5432 (econnrefused). Check that it is running and that the address and port are right.`             |
| Wrong user or password                          | `The database at host:5432 refused the user name or password in the connection string.`                                                        |
| The server wants TLS, or the string asks for it | `... requires an encrypted connection. Add ?sslmode=require ...`, or `... did not accept an encrypted connection ... add ?sslmode=disable ...` |
| A query took too long                           | `The query took longer than the statement timeout and was stopped.` That query is "could not check".                                           |
| A query was refused by layer 1                  | `The query "x" was not sent. DELETE changes data, even inside WITH. ...`                                                                       |
| The role cannot read a table                    | `The database user is not allowed to read what the query asks for. Grant SELECT on the tables it needs ...`                                    |
| More than 5,000 rows                            | `The query "x" returned more than 5,000 rows; only the first 5,000 were used.` (an advice notice)                                              |
| A service_role key                              | `That key is for the service_role role, which bypasses row-level security, so Gaugeline will not use it.`                                      |

A database that cannot be reached is never a pass. Its queries are "could not check" and every other
check carries on.

## Contributing: the classifier and its shared cases

The statement check is a port of the classifier in LocalQuery's read-only tier (LocalQuery is a
private project, so Gaugeline does not depend on it). The two copies are kept in step by one list of
test cases, `packages/core/src/connectors/postgres/classifier-cases.json`, which LocalQuery imports a
copy of. Each case is a piece of SQL and one verdict, `allow` or `refuse`. When either copy finds a
gap, add the case to the list and fix both.
