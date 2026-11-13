# Hosted: the inbox and approvals

The hosted version of Gaugeline (in progress, not released) lets an agent propose a fix and a person
decide. The agent writes a **draft**; the draft waits in the **inbox**; someone in your agency approves
it, edits it first, or declines it. Only an approval starts an **apply job**, and that job runs in your
own worker, with your own credentials, never in the checker or the hosted service.

## An example: a broken menu link at a cocktail bar

Last night's run of The Tidewater Bar found that `/menu` links to `/drinks-2025`, which returns 404.
An agent drafts a pull request that points the link at `/drinks`. Northgate Studio's developer opens the
inbox in the morning and sees one waiting draft:

| Site              | Kind           | What it proposes                 | Fixes                        |
| ----------------- | -------------- | -------------------------------- | ---------------------------- |
| The Tidewater Bar | `pull_request` | Point the menu link at `/drinks` | Broken link on the menu page |

- **Approve** records "approved" in her name and queues one apply job with the draft as written.
- **Edit first** lets her change the title or the text, records "edited" with the new payload, and queues
  the edited version. The agent's original draft stays exactly as it was, so the log shows both.
- **Decline** records "declined" with an optional reason and queues nothing.

The bar's manager has a client login. She sees her site's findings but not the drafts, and she cannot
approve anything: the database returns no draft to her, so there is nothing to decide.

## The agent can draft, and nothing else

An agent works for one organisation, and the database decides which one from the agent's **token**,
never from anything the agent's session can set. Each agent is a row of the
[agent registry](./agent-registry.md), with a name, an owner, scopes and its own token from the hosted app;
the database keeps only the token's SHA-256, and revoking the agent stops it at once.

The agent's connection uses the database role `gaugeline_agent`, which holds no privilege on any table:
it cannot read the inbox, insert a draft directly, change a draft or record a decision. Its one way in is
the function `private.agent_insert_draft(token, site, kind, payload, finding_ids)`, which looks up the
token's organisation and refuses a site or a finding that is not that organisation's. The draft is in
nobody's name. Those are missing privileges and checks in the database, not an `if` in the app, so a
refactor cannot skip them.

This is the output of the seeded test database (`apps/hosted/db/__tests__/harness.ts` and migrations
`0005_drafts_inbox.sql` and `0012_agent_registry.sql`), run with `psql` 16 as written, including the one invented agent token for
Northgate Studio that the first statement adds. The session first claims to be Brightfield Web, which
changes nothing:

```sql
-- set-up, as the schema owner, with a fixed invented token so the example repeats (people register an
-- agent with private.register_agent, which mints the token; see the agent registry): its SHA-256 and
-- prefix, a name, an owner and the one scope this agent needs
insert into agents (org_id, name, owner_id, scopes, token_sha256, token_prefix)
  values ('0a000000-0000-4000-8000-00000000000a', 'Menu fixer', '11111111-0000-4000-8000-000000000001',
          '{draft:email}', '75ba71e74f134b7296af485bd0dc6f1b6b5bee0fb953435bcb11939ed7d55099', '01234567');

-- as the agent role; the session claims Brightfield Web's organisation
begin;
select set_config('request.jwt.claims', '{"org_id":"0b000000-0000-4000-8000-00000000000b"}', true);
set local role gaugeline_agent;
-- 1. a direct insert, claiming Brightfield Web
insert into drafts (org_id, site_id, kind, payload)
  values ('0b000000-0000-4000-8000-00000000000b', 'b1000000-0000-4000-8000-0000000000b1', 'email',
          '{"subject":"x","body":"y"}');
rollback;
begin;
set local role gaugeline_agent;
-- 2. Northgate's agent token, naming Brightfield's site
select private.agent_insert_draft($1, $2, $3, $4)
  \bind 'gla_0123456789abcdef0123456789abcdef' 'b1000000-0000-4000-8000-0000000000b1' 'email' '{"subject":"x","body":"y"}' \g
rollback;
begin;
set local role gaugeline_agent;
-- 3. the same token, naming its own organisation's site
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind 'gla_0123456789abcdef0123456789abcdef' 'a1000000-0000-4000-8000-0000000000a1' 'email' '{"subject":"Your menu link is fixed","body":"The drinks page is back."}' \g
rollback;
begin;
set local role gaugeline_agent;
-- 4. the same token, a payload that is not an email
select private.agent_insert_draft($1, $2, $3, $4)
  \bind 'gla_0123456789abcdef0123456789abcdef' 'a1000000-0000-4000-8000-0000000000a1' 'email' '{"subject":"Menu link","body":"Fixed.","to":"owner@example.test"}' \g
rollback;
```

```text
INSERT 0 1
BEGIN
                    set_config
---------------------------------------------------
 {"org_id":"0b000000-0000-4000-8000-00000000000b"}
(1 row)

SET
ERROR:  permission denied for table drafts
ROLLBACK
BEGIN
SET
ERROR:  site not found for this agent
CONTEXT:  PL/pgSQL function private.agent_insert_draft(text,uuid,text,jsonb,uuid[]) line 26 at RAISE
ROLLBACK
BEGIN
SET
 inserted
----------
 t
(1 row)

ROLLBACK
BEGIN
SET
ERROR:  the payload does not match the email shape: payload must have exactly subject and body
CONTEXT:  PL/pgSQL function private.drafts_check_payload() line 8 at RAISE
SQL statement "insert into public.drafts (org_id, site_id, kind, payload, finding_ids, created_by)
    values (v_org, p_site_id, p_kind, p_payload, coalesce(p_finding_ids, '{}'), null)
    returning id"
PL/pgSQL function private.agent_insert_draft(text,uuid,text,jsonb,uuid[]) line 44 at SQL statement
ROLLBACK
```

**The agent's token is always a bind parameter, never text in the statement.** Above, `\bind` sends the
token apart from the SQL (`$1`). A token written into the statement is a literal, and when a call fails
Postgres writes the failing statement to its server log (`log_min_error_statement` defaults to `error`),
so the token would land in the log. With a driver, use its parameters (a tagged template in postgres.js,
never string concatenation). Parameters are logged only when you ask for it, so on the agent's database
leave `log_statement` at `none` and `log_parameter_max_length` and `log_parameter_max_length_on_error` at
`0` where the host lets you set them.

What the owner sets up: a database login for the agent service that is a member of `gaugeline_agent`
only (like the app's login, never the table owner), and one registered agent per agent program, each with
its own token ([agent registry](./agent-registry.md)). Nothing is created by this change. `agentLoginsWithOtherRoles`
(`apps/hosted/db/audit.ts`) lists any login that is a member of `gaugeline_agent` and also of
`authenticated` or `service_role`; such a login could act as a person or as the server, so the list must
be empty, like the checks in the data model page.

An agent cannot flood the inbox: a draft names at most 50 findings, and a site holds at most 200 drafts
waiting for a decision. The 201st call fails with "this site already has 200 drafts waiting for a decision"
until someone decides or declines some. The cap is per site, so one noisy site does not block the others.
The count is exact when callers arrive together under the default isolation level (READ COMMITTED) and
under SERIALIZABLE; the function refuses to run at REPEATABLE READ, where each caller would count a stale
snapshot, so an agent connection must not set that level. A draft's findings are a flat list.

## Only fixed shapes can be approved

A draft is one of three kinds, and the database refuses any other for everyone who inserts one:

- `pull_request`: a title (one line), a description and up to 20 files. A path is plain characters,
  relative, and never reaches into git or the repository's automation: any `.git` directory, `.gitmodules`,
  `.github`, `.circleci`, `.gitlab-ci.yml` or `.husky`, at any depth and whatever the case, is refused, and
  so are `..` and a leading `-`. Two paths in one pull request that differ only by case are refused, since
  they would collide on a case-insensitive checkout.
- `email`: a subject (one line) and a body. Recipients come from the site's contacts, never the payload.
- `sanity_draft`: a document id, a type, up to 20 field values (`set`) and, for each of those fields, the
  SHA-256 of the value it has in the published document (`before`, 64 lower-case hex characters). A field
  name starts with a letter, so Sanity's own fields (`_id`, `_type`, `_rev`, ...) can never be set by a
  draft. The writer compares `before` with what the content system holds now and refuses a stale draft
  ([applying an approved fix](./writer.md)). A digest is stored, never the client's published text.

Unknown keys are refused, so a payload cannot name a branch, a repository, a recipient or a flag. A
one-line field refuses every line break and control character, including U+0085, the C1 controls
(U+0080 to U+009F) and U+2028 and U+2029, and also the bidirectional controls (U+202A to U+202E and
U+2066 to U+2069) and the non-characters U+FFFE and U+FFFF. A number in a Sanity field has at most 15
significant digits (so 0.1 is fine and 1/3 is not): Postgres keeps every digit of a number but the writer
reads it as a double, and the two must be the same value. The shapes are in `apps/hosted/inbox/kinds.ts`, and the writer
checks the same shapes again before it sends anything.

**The database checks the shape too, not only the app.** A signed-in person can write to `drafts` and
`decisions` without going through the inbox code (Supabase exposes both tables over REST), so a trigger on
each table runs the same rules (`private.draft_payload_problem`, a test gives it and `kinds.ts` the same
list of payloads and requires the same verdicts). A draft that does not fit its kind is refused when it is
written, whoever writes it; an approval is refused if the draft's payload does not fit, and an edit is
refused if the edit does not fit. So a hostile edit cannot be recorded, and cannot use up a draft's only
decision. One thing stays in the app: the "this finding has closed" confirmation below is a second click for
a person to make, not a safeguard, so someone writing to the table directly does not see it.

**Rule for the jobs table (G36) and the writer:** an apply job is created only from a decision row, using
that row's payload (the draft's for `approved`, `edited_payload` for `edited`) and its `payload_sha256`,
and never from a payload anyone supplies separately. Every decision row has passed the database's shape
check, and the worker checks the hash and the shape again before it writes anything.

Approve checks the agent's payload, and Edit first checks the edit, before anything is recorded. A draft
whose payload does not fit can only be declined. An edit is capped at 16 KB (measured on the text Postgres
stores, which has a space after each colon and comma), like a draft. A payload over the cap, containing
U+0000 or an unpaired surrogate, or a number such as `1e21` that JSON and Postgres print differently, is
reported as an invalid payload, with the reason, rather than failing in the database. If the database
refuses a payload the app passed (it sees exact decimals, where the app sees a parsed double), that is
reported the same way and nothing is recorded.

## One decision per draft

A draft is decided once. A unique index on `decisions (draft_id)` for the three choices means a double
click, or two colleagues pressing Approve at the same moment, gives one decision row and one apply job.
The second click is told who decided first. To change course after a decision, the agent writes a new
draft; the old decision stays in the log, which nobody can edit or delete (see
[data model](./data-model.md#decisions-the-app-cannot-rewrite)).

## When the finding has already closed

If a later clean run no longer reports the finding a draft was written for (someone fixed it by hand),
Approve warns first and names the closed findings. A second, confirmed Approve records the decision.
Decline never warns.

A run counts as clean when it finished and its stored summary does not say `partial` or carry an `error`.
It does not close a finding whose check it could not run (the check is listed under `couldNotCheck`: its
silence means nothing), and it does not close anything when `couldNotCheck` holds 20 entries, because the
summary keeps no more than 20 and the list may have been cut off. A job that failed stores no run at all
(G36 keeps only a short code on the job), so it cannot close a finding either.

## What happens after an approval

The decision and the apply job are written in one transaction. The database records the SHA-256 of the
exact payload approved (the edited one after Edit first) on the decision row; nobody can supply it. The
job carries that payload text, its hash and the decision's id, and the worker refuses a job whose payload
does not hash to the approval. Your worker claims it and runs the writer
package with your own credentials. The writer may only open a pull request on a new branch, create a
content-system draft, or create a mailbox draft; it never merges, publishes or sends. See
[What it can and can't write](../writes.md#fixes-you-approve-hosted).

Status: the inbox, the decision log and the enqueue are built (`apps/hosted/inbox/inbox.ts`). The jobs
table arrives with the nightly queue (G36); until then the enqueue is an interface with an in-memory
stand-in. The inbox screen, its live updates and the writer package follow in the next pull requests.
