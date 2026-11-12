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

The agent connects with its own database role, `gaugeline_agent`. It may insert a draft into the
organisation its credentials name, of a kind the writer knows (`pull_request`, `email`, `sanity_draft`),
in nobody's name. It cannot read the inbox, change a draft or record a decision. That is a missing
privilege, not an `if` in the app, so a refactor cannot skip it. This is the output of the seeded test
database (`apps/hosted/db/__tests__/harness.ts` plus migration `0003_drafts_inbox.sql`):

```sql
-- as the agent role, with an agent's claims for Northgate Studio
begin;
set local role gaugeline_agent;
insert into drafts (org_id, site_id, kind, payload)
  values ('0a000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-0000000000a1', 'pull_request',
          '{"title":"Point the menu link at /drinks"}');
insert into decisions (org_id, draft_id, decision, decided_by)
  values ('0a000000-0000-4000-8000-00000000000a', 'a1d10000-0000-4000-8000-0000000000a1', 'approved',
          '11111111-0000-4000-8000-000000000001');
rollback;
```

```text
BEGIN
SET
INSERT 0 1
ERROR:  permission denied for table decisions
ROLLBACK
```

## One decision per draft

A draft is decided once. A unique index on `decisions (draft_id)` for the three choices means a double
click, or two colleagues pressing Approve at the same moment, gives one decision row and one apply job.
The second click is told who decided first. To change course after a decision, the agent writes a new
draft; the old decision stays in the log, which nobody can edit or delete (see
[data model](./data-model.md#decisions-the-app-cannot-rewrite)).

## When the finding has already closed

If a later run no longer reports the finding a draft was written for (someone fixed it by hand),
Approve warns first and names the closed findings. A second, confirmed Approve records the decision.
Decline never warns.

## What happens after an approval

The decision and the apply job are written in one transaction. The job carries the approved payload
(the edited one after Edit first) and the decision's id. Your worker claims it and runs the writer
package with your own credentials. The writer may only open a pull request on a new branch, create a
content-system draft, or create a mailbox draft; it never merges, publishes or sends. See
[What it can and can't write](../writes.md#drafts-it-writes-after-you-approve).

Status: the inbox, the decision log and the enqueue are built (`apps/hosted/inbox/inbox.ts`). The jobs
table arrives with the nightly queue (G36); until then the enqueue is an interface with an in-memory
stand-in. The inbox screen, its live updates and the writer package follow in the next pull requests.
