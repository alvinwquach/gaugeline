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

Signed in as Northgate's owner, a plain `select` returns Northgate's two sites and nothing of
Brightfield's, and an insert claiming Brightfield's organisation is refused by the database, not by
application code. This is the output of the seeded test database (`apps/hosted/db/__tests__/harness.ts`):

```sql
-- as the signed-in user 11111111-...-001 (Northgate's owner), role authenticated
select name, url from sites order by name;
insert into sites (org_id, name, url)
  values ('0b000000-0000-4000-8000-00000000000b', 'Pop-up', 'https://popup.test');
```

```text
          name          |            url
------------------------+----------------------------
 Juniper Pop-up Kitchen | https://juniper-popup.test
 The Tidewater Bar      | https://tidewater-bar.test
(2 rows)

ERROR:  new row violates row-level security policy for table "sites"
```

## The tables

Every table has an `org_id` column and row-level security turned on.

| Table                                                         | What a row is                                                      | Notes                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `organisations`                                               | an agency or a business                                            | created by the server; owners and admins can rename it                                                |
| `members`                                                     | one person's role in one organisation                              | a `client` row names exactly one site                                                                 |
| `sites`                                                       | a site the organisation looks after                                | `timezone` sets when the nightly run starts                                                           |
| `runs`                                                        | one run of the checks against one site                             | `summary` holds counts, never the report                                                              |
| `findings`                                                    | one problem a run found                                            | `check_id`, `severity`, `title`, `evidence` (one line, at most 1000 characters), `url`, `fingerprint` |
| `drafts`                                                      | a proposed change waiting for a person                             | append-only; its state is the latest decision, not a column                                           |
| `decisions`                                                   | who approved, edited or declined a draft, and when                 | append-only                                                                                           |
| `site_consents`                                               | the site owner's consent to probing checks                         | append-only                                                                                           |
| `email_preferences`                                           | one person's morning-email address and setting in one organisation | a person reads and changes only their own setting; the address is set by the server                   |
| `email_sends`                                                 | one morning email to one person on one local day                   | server-only; the key (person, organisation, day) is what stops a second copy                          |
| `clients`, `invites`, `weekly_updates`, `weekly_update_sends` | an agency's clients, invites and weekly updates                    | see [agencies](./agencies.md)                                                                         |

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
| `member`                    | their organisations                                   | drafts and decisions, in their own name                      |
| `client`                    | their one site, its runs, findings and consent record | nothing                                                      |
| the server (`service_role`) | everything                                            | runs and findings; new drafts, decisions and consent records |

A person in two organisations sees both, and nothing else.

- **Runs and findings come only from the server.** A signed-in person cannot insert them; the runs API
  (G35) checks the site's upload token and inserts as `service_role`, so nobody can invent a finding.
- **Owners.** Only an owner adds, promotes, demotes or removes an owner; an admin cannot make anyone an
  owner, themselves included. The last owner of an organisation cannot leave or step down until someone
  else is an owner. That holds when two owners try to leave at the same moment: the removal writes the
  organisation row before counting owners, so the second one waits for the first. At READ COMMITTED (the
  default) the second then fails with "the last owner of an organisation cannot leave or step down"; at
  REPEATABLE READ or SERIALIZABLE it fails with "could not serialize access due to concurrent update"
  and can be retried. Either way one owner remains.
- **Role names.** The database roles are Supabase's: `authenticated` is the signed-in app user (the
  plan's "app" role) and `service_role` is the server and worker (the plan's "service" role). The
  plan's `agent` role is `gaugeline_agent` (G37): it may insert drafts, through one function that takes
  the organisation from the agent's token, and nothing else ([the inbox and approvals](./inbox.md)). Its
  login must be a member of that role only: `agentLoginsWithOtherRoles` in `db/audit.ts` lists any login
  that could also act as `authenticated` or `service_role`.
- **The app must never connect as the table owner.** The owner (`postgres` on Supabase) skips
  row-level security. Row-level security is not `FORCE`d: FORCE only binds the table owner, which runs
  the migrations and would then need its own policies, and it does nothing against a superuser or a
  `BYPASSRLS` role. Nothing in the app connects yet; see the rules below for the server (G35 onward).

### Rules for the server and the worker (G35 onward)

These are requirements, not yet code that runs: the server and worker arrive with G35 and G36.

1. **A separate login role.** The server and the worker connect with their own login role, like
   Supabase's `authenticator`: `NOINHERIT`, a member of `anon`, `authenticated` and `service_role`
   and of nothing riskier. It is not `postgres`, which owns the tables (and on Supabase has `BYPASSRLS`).
2. **The owner's address is for migrations only.** `GAUGELINE_DATABASE_URL` (the owner) is used by
   `db:migrate` and nothing else; the server gets a different address for its login role.
3. **Every query names its role.** A request from a signed-in person runs in a transaction that starts
   with `set local role authenticated` and sets `request.jwt.claims` to that person's claims; work for
   the server itself (an upload with a site token, the worker) runs as `set local role service_role`.
4. **Check once at start-up.** Before serving anything, call `assertConnectionRespectsRls()` from
   `db/audit.ts` once, outside any transaction. It looks at the login (`session_user`) and the role in
   effect (`current_user`) and refuses a connection that is, or is a member of (through any chain of
   roles), a superuser, a `BYPASSRLS` role other than `service_role`, or the owner of a table. `set role`
   can switch to any role a login is a member of, whatever `NOINHERIT` says, so membership is what
   counts. The server must not start if it throws.

## Decisions the app cannot rewrite

`drafts`, `decisions` and `site_consents` accept `INSERT` and `SELECT` only, for the app and the server.
`INSERT` is granted on named columns: the `id` and the time (`decided_at`, `recorded_at`) are always set
by the database, so nobody can choose an id to put a row "last", backdate it, or move the shared id
sequence to block another organisation's inserts. The app and the server hold no `UPDATE` or
`DELETE` privilege on these tables, so they are refused before anything else:

```sql
-- as the server
begin;
set local role service_role;
delete from decisions;
rollback;
```

```text
BEGIN
SET
ERROR:  permission denied for table decisions
ROLLBACK
```

A trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` even for a role that does hold those privileges,
such as the table owner:

```sql
-- as the owner
delete from decisions;
```

```text
ERROR:  decisions is append-only: DELETE is not allowed
HINT:  Insert a new row instead (a later decision, a withdrawal).
```

Changing your mind is a new row. The current state is a query over the log: the `draft_state` view gives
each draft's latest decision (`pending` when there is none). A draft never changes after it is written,
so an approval always refers to the payload that was shown; an edit is a decision of kind `edited` that
carries the new payload.

**What this does not stop.** The table owner (`postgres` on Supabase) can disable or drop the trigger,
add a rule, or (as a superuser, where allowed) set `session_replication_role = replica`. For example,
as the owner:

```sql
begin;
alter table decisions disable trigger decisions_append_only;
delete from decisions;
rollback;
```

```text
BEGIN
ALTER TABLE
DELETE 2
ROLLBACK
```

So the protection holds against the app, the server and anyone who gets their credentials, not against
the database owner. The owner role is used only to apply migrations, and migrations are applied only
after review. To notice misuse, log DDL and owner sessions (for example with the `pgaudit` extension or
an event trigger on `ddl_command_end`); that is set up with the real project (see the plan's owner needs).

**Deleting is limited too.** A site with drafts, decisions or consent records cannot be deleted
(`on delete restrict` and the append-only triggers), and neither can its organisation. Erasing an
organisation that leaves needs an owner-run procedure; that decision is open (see the plan).

## Email settings

The morning email (see [Hosted: the morning email](./morning-email.md)) needs a person's address, so the
address lives in `email_preferences`, one row per person and organisation, and nowhere else.

- The server sets the address and when it was confirmed (signing in with it confirms it). Nothing is
  sent to an unconfirmed address, a missing one, or one marked bounced.
- A person can read their own row and change two things: how often (`every_change`, `fix_first` or
  `off`) and their time zone. They cannot change the address, and they cannot see anyone else's.
- An empty setting means the default for the role: on for owners and admins, off for members. A client
  viewer is never mailed, whatever their row says.
- `email_sends` is the server's. It has one row per person, organisation and local day, keyed by those
  three, so a restart or a second worker cannot send the same morning twice. It holds a short error code
  and the window of changes the email covered, never an address or a message.
- Removing a member removes both rows.

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
GAUGELINE_MIGRATE_URL=postgres://... pnpm --filter @gaugeline/hosted db:migrate
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
