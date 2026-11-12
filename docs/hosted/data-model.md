# Hosted: data model and tenancy

The hosted version of Gaugeline (in progress, not released) keeps one thing per agency: its sites, the
nightly runs against them, what each run found, the changes proposed to fix it, and who decided what.
This page says what is stored, who can see each row, and why the database itself enforces it.

Everything here lives in `apps/hosted/db`. The migrations are plain SQL files, reviewed in the pull
request that adds them.

## An example: one agency, two clients

Northgate Studio is a two-person agency. It looks after The Tidewater Bar (a cocktail bar) and
Juniper Pop-up Kitchen (a weekend pop-up). The bar's manager has a client login so she can see her own
site's findings and nothing else. Another agency, Brightfield Web, looks after Maple Street Physio on
the same hosted service.

| Who                   | Role     | Sees                                                                                 |
| --------------------- | -------- | ------------------------------------------------------------------------------------ |
| Northgate's owner     | `owner`  | both Northgate sites, runs, findings, drafts, decisions; manages members and consent |
| Northgate's developer | `member` | the same rows; can approve or decline a draft in their own name                      |
| The bar's manager     | `client` | The Tidewater Bar only: its runs, findings and consent record. Read-only             |
| Brightfield's owner   | `owner`  | Maple Street Physio only. Nothing of Northgate's                                     |

Signed in as Northgate's owner, a plain `select` returns only Northgate's sites (one in this example
database), and an insert claiming Brightfield's organisation is refused by the database, not by
application code:

```sql
-- as the signed-in user 11111111-...-001 (Northgate's owner), role authenticated
select name, url from sites order by name;
insert into sites (org_id, name, url)
  values ('0b000000-0000-4000-8000-00000000000b', 'Pop-up', 'https://popup.test');
```

```text
       name        |            url
-------------------+----------------------------
 The Tidewater Bar | https://tidewater-bar.test
(1 row)

ERROR:  new row violates row-level security policy for table "sites"
```

## The tables

Every table has an `org_id` column and row-level security turned on.

| Table           | What a row is                                      | Notes                                                                                                 |
| --------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `organisations` | an agency or a business                            | created by the server; owners and admins can rename it                                                |
| `members`       | one person's role in one organisation              | a `client` row names exactly one site                                                                 |
| `sites`         | a site the organisation looks after                | `timezone` sets when the nightly run starts                                                           |
| `runs`          | one run of the checks against one site             | `summary` holds counts, never the report                                                              |
| `findings`      | one problem a run found                            | `check_id`, `severity`, `title`, `evidence` (one line, at most 1000 characters), `url`, `fingerprint` |
| `drafts`        | a proposed change waiting for a person             | its state is the latest decision, not a column                                                        |
| `decisions`     | who approved, edited or declined a draft, and when | append-only                                                                                           |
| `site_consents` | the site owner's consent to probing checks         | append-only                                                                                           |

**No page content is stored.** A finding keeps the one evidence line the CLI prints, the address and a
fingerprint. The database refuses a longer evidence value.

**Fingerprints join runs.** `fingerprint` is the same 16-character hash the CLI uses for baselines, so
"opened", "still open" and "closed" between two runs is a join on `(site_id, fingerprint)`, which has an
index. Runs have an index on `(site_id, started_at desc)` for "the latest run of each site".

**References repeat the organisation.** A finding's foreign key covers `(run_id, site_id, org_id)`, so a
finding cannot point at one organisation's run and claim another organisation, even for the server.

## Who can do what

| Role                        | Read                                                  | Write                                                        |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| not signed in (`anon`)      | nothing                                               | nothing                                                      |
| `owner`, `admin`            | their organisations                                   | sites, members, consent records; everything a member can     |
| `member`                    | their organisations                                   | runs, findings, drafts; decisions in their own name          |
| `client`                    | their one site, its runs, findings and consent record | nothing                                                      |
| the server (`service_role`) | everything                                            | everything except changing or removing a decision or consent |

A person in two organisations sees both, and nothing else.

## Decisions nobody can rewrite

`decisions` and `site_consents` accept `INSERT` and `SELECT` only. No role is granted `UPDATE` or
`DELETE`, and a trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` for every role, the server and the
table owner included:

```sql
delete from decisions;
```

```text
ERROR:  decisions is append-only: DELETE is not allowed
HINT:  Insert a new row instead (a later decision, a withdrawal).
```

Changing your mind is a new row. The current state is a query over the log: the `draft_state` view gives
each draft's latest decision (`pending` when there is none).

## Consent to probing checks

Probing checks request non-public paths or use a site's keys against its own APIs. On the CLI they need
`--owner-consent`; on the hosted service they need a consent row for the site.

- Only an owner or admin records consent, in their own name, with the version of the consent wording
  they agreed to.
- Withdrawing consent is a new `withdrawn` row. The `site_consent_current` view lists the sites whose
  latest row is `granted`.
- **The rule for the worker (G36):** it refuses to run a probing check for a site unless
  `site_consent_current` has a row for that site whose `wording_version` is the current wording, and the
  run asked for probing checks. No row, a withdrawal, or older wording: the probing checks report
  "could not check" with the reason, and the public checks run as usual.

## Why the database enforces it

One forgotten `where org_id = ?` in application code would show one customer another's findings. With
row-level security the database refuses whatever the query. The cost is that policies are harder to
debug and every query plan carries the predicate.

Views in Supabase's exposed schema are created with `security_invoker`, so a view reads as the caller
and cannot read around the policies. A test lists every table and view and fails if a table has
row-level security off, has no `org_id`, or a view runs with its owner's rights.

## Running the migrations

```bash
GAUGELINE_DATABASE_URL=postgres://... pnpm --filter @gaugeline/hosted db:migrate
```

```text
applied: 0001_tables, 0002_tenancy
```

Run it again and it prints `up to date`. Each run is one transaction: if a file fails, nothing from that
run stays. The connection must be the schema owner (`postgres` on Supabase).

## Testing locally

The tests need a Postgres server you can create databases on. They make a fresh database per test file,
apply a small stand-in for what a Supabase project provides (`apps/hosted/db/stand-in/supabase-auth.sql`:
the `anon`, `authenticated` and `service_role` roles and `auth.uid()`; never run it on Supabase), then
the migrations:

```bash
GAUGELINE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres pnpm exec vitest run apps/hosted
```

Without `GAUGELINE_TEST_DATABASE_URL` the database tests are skipped. CI runs them in the `hosted-db`
job against a Postgres service container.
