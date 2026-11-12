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
never from anything the agent's session can set. Each organisation's agent gets its own token from the
hosted app; the database keeps only its SHA-256 (`private.agent_tokens`), and revoking it stops the agent
at once.

The agent's connection uses the database role `gaugeline_agent`, which holds no privilege on any table:
it cannot read the inbox, insert a draft directly, change a draft or record a decision. Its one way in is
the function `private.agent_insert_draft(token, site, kind, payload, finding_ids)`, which looks up the
token's organisation and refuses a site or a finding that is not that organisation's. The draft is in
nobody's name. Those are missing privileges and checks in the database, not an `if` in the app, so a
refactor cannot skip them.

This is the output of the seeded test database (`apps/hosted/db/__tests__/harness.ts`, migration
`0005_drafts_inbox.sql`, and one invented agent token for Northgate Studio). The session first claims to
be Brightfield Web, which changes nothing:

```sql
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
select private.agent_insert_draft('gla_0123456789abcdef0123456789abcdef',
  'b1000000-0000-4000-8000-0000000000b1', 'email', '{"subject":"x","body":"y"}');
rollback;
begin;
set local role gaugeline_agent;
-- 3. the same token, naming its own organisation's site
select private.agent_insert_draft('gla_0123456789abcdef0123456789abcdef',
  'a1000000-0000-4000-8000-0000000000a1', 'email',
  '{"subject":"Your menu link is fixed","body":"The drinks page is back."}') is not null as inserted;
rollback;
```

```text
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
CONTEXT:  PL/pgSQL function private.agent_insert_draft(text,uuid,text,jsonb,uuid[]) line 16 at RAISE
ROLLBACK
BEGIN
SET
 inserted
----------
 t
(1 row)

ROLLBACK
```

What the owner sets up: a database login for the agent service that is a member of `gaugeline_agent`
only (like the app's login, never the table owner), and one agent token per organisation, created by the
hosted app (G35's token code). Nothing is created by this change.

## Only fixed shapes can be approved

A draft is one of three kinds, and the database refuses any other for everyone who inserts one:
`pull_request` (a title, a description and up to 20 files, each a plain relative path outside `.git` and
`.github`), `email` (a subject and a body; recipients come from the site's contacts, never the payload)
and `sanity_draft` (a document id, a type and up to 20 field values). Unknown keys are refused, so a
payload cannot name a branch, a repository, a recipient or a flag. The shapes are in
`apps/hosted/inbox/kinds.ts`, and the writer checks the same shapes again before it sends anything.

Approve checks the agent's payload, and Edit first checks the edit, before anything is recorded. A draft
whose payload does not fit can only be declined. An edit is capped at 16 KB, like a draft.

## One decision per draft

A draft is decided once. A unique index on `decisions (draft_id)` for the three choices means a double
click, or two colleagues pressing Approve at the same moment, gives one decision row and one apply job.
The second click is told who decided first. To change course after a decision, the agent writes a new
draft; the old decision stays in the log, which nobody can edit or delete (see
[data model](./data-model.md#decisions-the-app-cannot-rewrite)).

## When the finding has already closed

If a later complete run (finished, not partial) no longer reports the finding a draft was written for
(someone fixed it by hand),
Approve warns first and names the closed findings. A second, confirmed Approve records the decision.
Decline never warns.

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
