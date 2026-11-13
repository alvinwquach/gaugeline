# Hosted: where secrets live

The hosted version of Gaugeline (in progress, not released) holds as few secrets as it can. This page
says where each kind lives, who can read it, how to rotate it, and what a breach of the app could and
could not reach.

## An example: an agency's Slack channel

Northgate Studio wants a message in its `#tidewater-bar` Slack channel when the cocktail bar's site
breaks overnight. Slack gives them an incoming webhook URL. Anyone holding that URL can post into the
channel, so it is a secret: it goes into Supabase Vault, and the hosted app keeps only a pointer to it.

The settings API stores it, and only the worker can read it back. Signed in, Northgate's owner sees that
a secret called `slack-tidewater` exists, and nothing more. Brightfield Web, another agency on the same
service, gets nothing back for the same name. The value always travels as a bind parameter (`$4`), never
inside the SQL text. This is psql 16 against the test stand-in (`apps/hosted/db/stand-in/supabase-vault.sql`)
with the migrations applied and two invented organisations:

```sql
-- the settings API stores it (role service_role); the value is a bind parameter, never in the SQL text
set role service_role;
select private.put_secret($1, $2, $3, $4)
\bind '0a000000-0000-4000-8000-00000000000a' 'slack-tidewater' 'webhook_url' 'https://hooks.slack.test/services/T0NORTHGATE/B0TIDEWATER/example' \g
select private.get_secret($1, $2) \bind '0a000000-0000-4000-8000-00000000000a' 'slack-tidewater' \g
-- the worker reads it (role gaugeline_worker); Brightfield gets nothing for the same name
set role gaugeline_worker;
select private.get_secret($1, $2) \bind '0a000000-0000-4000-8000-00000000000a' 'slack-tidewater' \g
select private.get_secret($1, $2) \bind '0b000000-0000-4000-8000-00000000000b' 'slack-tidewater' \g
reset role;
-- Northgate's owner, signed in (role authenticated)
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000001"}', false) \g /dev/null
set role authenticated;
select name, kind, rotated_at from private.secret_refs;
select decrypted_secret from vault.decrypted_secrets;
```

```text
 put_secret
------------
 created
(1 row)

ERROR:  permission denied for function get_secret
                            get_secret
-------------------------------------------------------------------
 https://hooks.slack.test/services/T0NORTHGATE/B0TIDEWATER/example
(1 row)

 get_secret
------------

(1 row)

      name       |    kind     | rotated_at
-----------------+-------------+------------
 slack-tidewater | webhook_url |
(1 row)

ERROR:  permission denied for schema vault
LINE 1: select decrypted_secret from vault.decrypted_secrets;
                                     ^
```

## Where each kind of secret lives

| Secret                                                                      | Where it lives                                         | Who can read it                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| Per-site CMS tokens (Sanity, Contentful, Shopify, ...)                      | the customer's own CI or worker. **Never stored here** | only the customer's job                           |
| GitHub App private key (fix proposals, ADR-0010)                            | the customer's worker environment. **Never stored**    | only the customer's worker                        |
| Notification webhook URLs (Slack, Sentry, GitHub; X67)                      | Supabase Vault, one per organisation and name          | the hosted worker (`gaugeline_worker`) only       |
| Chat approval signing secrets (Slack, Discord, Teams; X69)                  | Supabase Vault, one per organisation and name          | the hosted worker (`gaugeline_worker`) only       |
| Site upload tokens and agent tokens                                         | a SHA-256 hash only (`tokens`, `private.agent_tokens`) | nobody: the token itself is shown once, then gone |
| Server secrets (`SUPABASE_SERVICE_ROLE_KEY`, database URLs, the Resend key) | the server's environment variables                     | the server process; never a table, log or report  |

"We never hold your keys" (G35) is about the first two rows: anything that can read or write a
customer's site or content stays with the customer.

## How the Vault part works

- `private.secret_refs` has one row per secret: organisation, name, kind (`webhook_url` or
  `signing_secret`), the Vault id, `created_at`, `rotated_at`. **Never the value.**
- `private.put_secret(org, name, kind, value)` stores a new secret (`created`) or replaces the value of
  an existing one (`rotated`). `private.get_secret(org, name)` returns the value, or null when that
  organisation has no secret by that name. `private.delete_secret(org, name)` returns whether one was
  deleted. All three are `SECURITY DEFINER` with an empty `search_path` (a test checks every such
  function in `private`).
- Reading a value needs the `gaugeline_worker` role, which may execute `get_secret` and nothing else.
  Writing and deleting (which never return the value) need `service_role`, for the settings API and the
  worker. `service_role` cannot read a value, so the runs API's login, which is a member of
  `service_role`, cannot either. `anon`, `authenticated` and `gaugeline_agent` can do none of it.
- Two first puts of one name at once give `created` then `rotated`: the second waits on a lock. That
  needs READ COMMITTED (the default); `put_secret` refuses REPEATABLE READ and SERIALIZABLE.
- Names are 1 to 63 characters of `a-z 0-9 _ . -`, starting with a letter. A value is 1 to 4096 bytes.
  A secret keeps its kind; to change it, delete it and put it again.
- A signed-in owner or admin can read their own organisation's names, kinds and dates (for a settings
  page), never another organisation's, never the Vault id and never the value. A member or client
  viewer sees none.
- `private.secret_events` records every create, rotate and delete (organisation, name, kind, action,
  time). It is append-only and never holds a value.
- Deleting a secret, or a whole organisation, deletes its Vault row too.
- Errors name the problem ("secret value must be 1 to 4096 bytes"), never the value. The app sends the
  value as a query parameter, so the statement text in `pg_stat_activity` and `pg_stat_statements`
  shows `$4`, not the value. Parameters can still reach the server log: see the owner's steps below.

## The worker's login

`gaugeline_worker` is `NOLOGIN`. Give it to the worker's own login, the one in `GAUGELINE_DATABASE_URL`
in the worker's process, and never to the runs API's login (the API process reads a variable of the same
name, with a different login in it):

```sql
-- once, as the owner; gl_worker_login is the worker's login role
grant gaugeline_worker to gl_worker_login;
```

The worker then switches to `gaugeline_worker` for the one transaction that reads a value, the way it
switches to `service_role` for everything else.

## From the worker's code

The worker reaches secrets through one interface, `SecretStore` in `apps/hosted/worker/secrets.ts`:
`put(orgId, name, kind, value)`, `get(orgId, name)` (null when missing), `delete(orgId, name)` and
`list(orgId)` (names, kinds and dates, never a value). `GAUGELINE_SECRET_STORE` picks the implementation
and has no default:

- `vault`: the functions above on the worker's database login. `put`, `delete` and `list` run as
  `service_role`; `get` runs as `gaugeline_worker` (so the login must be granted it, see "The worker's
  login"). A put that loses a race with another first put of the same name is retried once and rotates.
- `memory`: a `Map` in the process, for tests and local development. It runs only when `NODE_ENV` is
  exactly `development` or `test`; unset, `staging`, `production` or anything else is refused.

**Required for X67 (not wired yet):** nothing calls `secretStoreFrom` today, because nothing reads a
secret yet. The first row that does (X67, notifications) must call it once at the worker's start-up,
next to the database check, so a missing or wrong `GAUGELINE_SECRET_STORE`, or a worker login without
`gaugeline_worker`, stops the worker before its first job instead of failing a notification later.

Every failure is a `SecretError` with a code (`invalid-org`, `invalid-name`, `invalid-kind`,
`invalid-value`, `kind-mismatch`, `unavailable`) and a fixed message. A lost race that fails twice is
`unavailable`. A database error is replaced, not
wrapped, because a driver error can carry the query's parameters, and the parameters include the value.

## Rotation

Put the new value under the same name: `private.put_secret` replaces it in Vault, sets `rotated_at` and
records a `rotated` event. The old value is gone from Vault at once; revoke it at the provider too (a
Slack webhook is revoked in the Slack app's settings). Server secrets in environment variables rotate by
changing the variable and restarting the server and the worker.

## What a breach could reach

| If someone got...                                          | They could read                                            | They could not read                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| a signed-in person's session                               | their organisations' rows and secret names                 | any secret value, any other organisation                |
| a copy of the database or a backup                         | the Vault table, encrypted                                 | the values: Vault's key is not in the database          |
| the runs API's or settings API's `service_role` connection | secret names; it can overwrite or delete a secret          | any secret value: `get_secret` needs `gaugeline_worker` |
| the worker's connection (`gaugeline_worker`)               | every organisation's webhook URLs and chat signing secrets | CMS tokens, the GitHub App key: they were never here    |
| the database owner role (`postgres`)                       | everything in the database, Vault included                 | CMS tokens, the GitHub App key                          |

So a full breach of the hosted app can post into customers' notification channels and forge chat
approvals, and both are fixed by rotating those secrets. It cannot read or change a customer's site or
content.

## Needs from the owner before launch

1. Enable the `supabase_vault` extension on the Supabase project (Database, Extensions). Migration 0006
   stops with "Supabase Vault is not enabled on this database" until it is; it never creates the
   extension itself.
2. Keep bind parameters out of the server log. Any of these writes the value into the log as
   `DETAIL: parameters: ... $4 = '...'`: `log_statement = 'all'` (or `mod`), `log_min_duration_statement`
   at `0` or any value a slow call exceeds, and `auto_explain` with parameter logging. Keep
   `log_statement` at `none` or `ddl`, as the Vault README advises, and where the platform allows set
   `log_parameter_max_length = 0` (and keep `log_parameter_max_length_on_error` at its default `0`) on the
   logins of the worker and the settings API: `alter role gl_worker_login set log_parameter_max_length = 0;`.
3. Grant `gaugeline_worker` to the worker's login only (above).
4. If migration 0006 fails with "Vault is reachable outside private.get_secret: ...", the platform has
   granted a role access that the migration owner cannot take back (REVOKE only removes grants the
   revoking role made). Revoke the listed privileges as the role that granted them (on Supabase, from the
   SQL editor), then migrate again. The migration never ships with Vault reachable. To look by hand:

```sql
select r,
  has_schema_privilege(r, 'vault', 'usage') as schema_usage,
  has_table_privilege(r, 'vault.secrets', 'select') as secrets,
  has_table_privilege(r, 'vault.decrypted_secrets', 'select') as decrypted,
  has_function_privilege(r, 'vault.create_secret(text, text, text, uuid)', 'execute') as create_fn,
  has_function_privilege(r, 'vault.update_secret(uuid, text, text, text, uuid)', 'execute') as update_fn
from unnest(array['anon', 'authenticated', 'gaugeline_agent', 'gaugeline_worker', 'service_role']) as r;
```

Every column should say `false` (for `service_role`, the two table columns at least).

## Test stand-in

Plain Postgres has no Vault. The tests and the local stack load `apps/hosted/db/stand-in/supabase-vault.sql`,
which makes the same table, view and functions with the same signatures, copied from the extension's
source. It refuses to load where the real `supabase_vault` extension is installed. It scrambles values with a fixed test key printed in the file: it never stores plaintext, and it
protects nothing. It is never run on a Supabase project.
