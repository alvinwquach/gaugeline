# Hosted: where secrets live

The hosted version of Gaugeline (in progress, not released) holds as few secrets as it can. This page
says where each kind lives, who can read it, how to rotate it, and what a breach of the app could and
could not reach.

## An example: an agency's Slack channel

Northgate Studio wants a message in its `#tidewater-bar` Slack channel when the cocktail bar's site
breaks overnight. Slack gives them an incoming webhook URL. Anyone holding that URL can post into the
channel, so it is a secret: it goes into Supabase Vault, and the hosted app keeps only a pointer to it.

The worker stores and reads it. Signed in, Northgate's owner sees that a secret called `slack-tidewater`
exists, and nothing more. Brightfield Web, another agency on the same service, gets nothing back for the
same name. This is the output against the test stand-in (`apps/hosted/db/stand-in/supabase-vault.sql`)
with the migrations applied and two invented organisations:

```sql
-- as the worker (role service_role)
set role service_role;
select private.put_secret('0a000000-0000-4000-8000-00000000000a', 'slack-tidewater',
  'webhook_url', 'https://hooks.slack.test/services/T0NORTHGATE/B0TIDEWATER/example');
select private.get_secret('0a000000-0000-4000-8000-00000000000a', 'slack-tidewater');
select private.get_secret('0b000000-0000-4000-8000-00000000000b', 'slack-tidewater');
reset role;
-- as Northgate's owner, signed in (role authenticated)
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000001"}', false);
set role authenticated;
select name, kind, rotated_at from private.secret_refs;
select private.get_secret('0a000000-0000-4000-8000-00000000000a', 'slack-tidewater');
select decrypted_secret from vault.decrypted_secrets;
```

```text
 put_secret
------------
 created
(1 row)

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

ERROR:  permission denied for function get_secret
ERROR:  permission denied for schema vault
```

## Where each kind of secret lives

| Secret                                                                      | Where it lives                                         | Who can read it                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| Per-site CMS tokens (Sanity, Contentful, Shopify, ...)                      | the customer's own CI or worker. **Never stored here** | only the customer's job                           |
| GitHub App private key (fix proposals, ADR-0010)                            | the customer's worker environment. **Never stored**    | only the customer's worker                        |
| Notification webhook URLs (Slack, Sentry, GitHub; X67)                      | Supabase Vault, one per organisation and name          | the hosted worker, through `private.get_secret`   |
| Chat approval signing secrets (Slack, Discord, Teams; X69)                  | Supabase Vault, one per organisation and name          | the hosted worker, through `private.get_secret`   |
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
  deleted. All three are `SECURITY DEFINER` with an empty `search_path`, and only `service_role` (the
  worker and the runs API) may execute them. `anon`, `authenticated` and `gaugeline_agent` may not.
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
  shows `$4`, not the value.

## Rotation

Put the new value under the same name: `private.put_secret` replaces it in Vault, sets `rotated_at` and
records a `rotated` event. The old value is gone from Vault at once; revoke it at the provider too (a
Slack webhook is revoked in the Slack app's settings). Server secrets in environment variables rotate by
changing the variable and restarting the server and the worker.

## What a breach could reach

| If someone got...                                  | They could read                                            | They could not read                                  |
| -------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| a signed-in person's session                       | their organisations' rows and secret names                 | any secret value, any other organisation             |
| a copy of the database or a backup                 | the Vault table, encrypted                                 | the values: Vault's key is not in the database       |
| the server's or worker's `service_role` connection | every organisation's webhook URLs and chat signing secrets | CMS tokens, the GitHub App key: they were never here |
| the database owner role (`postgres`)               | everything in the database, Vault included                 | CMS tokens, the GitHub App key                       |

So a full breach of the hosted app can post into customers' notification channels and forge chat
approvals, and both are fixed by rotating those secrets. It cannot read or change a customer's site or
content.

## Needs from the owner before launch

1. Enable the `supabase_vault` extension on the Supabase project (Database, Extensions). Migration 0006
   stops with "Supabase Vault is not enabled on this database" until it is; it never creates the
   extension itself.
2. Keep statement logging off for parameters (`log_statement` at `none` or `ddl`), as the Vault README
   advises, so a value never reaches the logs.
3. After migrating, check on the real project that the API roles cannot reach Vault directly (the
   migration takes back any grant it can, and warns if it cannot):

```sql
select r, has_table_privilege(r, 'vault.decrypted_secrets', 'select') as can_read
from unnest(array['anon', 'authenticated', 'service_role']) as r;
```

Every row should say `false`.

## Test stand-in

Plain Postgres has no Vault. The tests and the local stack load `apps/hosted/db/stand-in/supabase-vault.sql`,
which makes the same table, view and functions with the same signatures, copied from the extension's
source. It scrambles values with a fixed test key printed in the file: it never stores plaintext, and it
protects nothing. It is never run on a Supabase project.
