# Hosted: the agent registry

The hosted version of Gaugeline (in progress, not released) lets an agent propose a fix as a draft that a
person approves ([the inbox](./inbox.md)). The **agent registry** is the list of every agent allowed to do
that in your workspace. An agent that is not in the registry cannot draft anything. Each entry says who
answers for the agent and what it may draft, and one action stops it.

## What one entry holds

| Field                  | What it is                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| name                   | one line, unique in the organisation ("Menu fixer")                                                                                                                 |
| owner                  | a staff member (owner, admin or member) of the same organisation, never a client viewer; it stays until you name another, or they leave                             |
| scopes                 | from a closed list (below), each at most once; a new agent has none unless you grant them                                                                           |
| token prefix           | the 8 characters after `gla_` that find the agent in a list                                                                                                         |
| token                  | **minted by the database and not stored**: shown once when the agent is registered; the database keeps its SHA-256 only. Nobody chooses a token, a hash or a prefix |
| created, last used     | set by the database: created when registered, last used when a draft or a read is allowed                                                                           |
| status                 | `active`, `disabled` (off until switched back on) or `revoked` (off for good)                                                                                       |
| revoked at, revoked by | set by the database, from its clock and the signed-in person, when the agent is revoked                                                                             |

The scopes are one per kind of draft and two reads. None of them writes: agents only draft, and only
your own worker applies an approved draft ([applying an approved fix](./writer.md)).

| Scope                | Lets the agent                                                                      |
| -------------------- | ----------------------------------------------------------------------------------- |
| `draft:pull_request` | propose a pull request                                                              |
| `draft:email`        | propose an email                                                                    |
| `draft:sanity_draft` | propose a Sanity draft document                                                     |
| `read:runs`          | read one site's run history at a time, through `private.agent_list_runs` (AG-08)    |
| `read:pending`       | list the drafts waiting for a decision through `private.agent_list_pending` (AG-08) |

**Registering is one call**, `private.register_agent(organisation, name, owner, scopes)`, for an owner or
admin of that organisation. Nobody inserts a row any other way. The database mints the token (256 bits
from the server's strong random source), stores its SHA-256 and prefix, and returns the token once. If a
new token or prefix happens to match one that exists, in any organisation, the function quietly tries
again, so no answer ever tells you whether another agency's prefix or hash exists.

**Who sees the registry:** owners and admins of the organisation, and nobody else. A member who is not an
admin and a client viewer see no agent, no history and no flag, and an owner of one agency never sees
another's. The agent itself cannot read the registry: its database role (`gaugeline_agent`) holds no
privilege on any table: it may run `private.agent_insert_draft` and, since AG-08, the two reads
`private.agent_list_pending` and `private.agent_list_runs`, and nothing else.

## An example: the bar's menu fixer, registered and revoked

Northgate Studio runs an agent that drafts fixes for The Tidewater Bar's menu links. Its owner registers
it with two scopes, the agent drafts an email, and then she revokes it. A second agent belongs to a
freelancer who then leaves the agency. This is the output of the seeded test database
(`apps/hosted/db/__tests__/harness.ts` and migrations `0012_agent_registry.sql` and `0013_agent_policy.sql`), run with `psql` 16 as
written, as the schema owner switching roles the way the app's and the agent's logins do. The token is
random on every run, so the example keeps it in a psql variable and prints only that it has the right
shape:

```sql
-- Northgate Studio's owner, signed in (the app's login switches to `authenticated` with her claims)
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000001"}', false) is not null as signed_in;

-- 1. register an agent: the database mints the token and returns it once (kept here in a psql variable)
select agent_id, token_prefix, token as menu_fixer_token
  from private.register_agent('0a000000-0000-4000-8000-00000000000a', 'Menu fixer',
                              '11111111-0000-4000-8000-000000000001', '{draft:email,draft:pull_request}') \gset
select :'menu_fixer_token' ~ '^gla_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$' as token_shown_once,
       substr(:'menu_fixer_token', 5, 8) = :'token_prefix' as prefix_matches;
select name, scopes, status, origin, last_used_at from agents;

-- 2. a scope that is not on the list, and one scope twice
select agent_id from private.register_agent('0a000000-0000-4000-8000-00000000000a', 'Publisher',
  '11111111-0000-4000-8000-000000000001', '{draft:email,write:publish}');
select agent_id from private.register_agent('0a000000-0000-4000-8000-00000000000a', 'Echo',
  '11111111-0000-4000-8000-000000000001', '{draft:email,draft:email}');

-- 3. choosing a token by hand, and setting "last used" by hand
insert into agents (org_id, name, owner_id, token_sha256, token_prefix)
  values ('0a000000-0000-4000-8000-00000000000a', 'Hand-made', '11111111-0000-4000-8000-000000000001',
          repeat('a', 64), 'aaaaaaaa');
update agents set last_used_at = now() where name = 'Menu fixer';

-- 4. the agent drafts an email with its token (the agent's own role)
reset role;
set role gaugeline_agent;
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind :menu_fixer_token 'a1000000-0000-4000-8000-0000000000a1' 'email' '{"subject":"Your menu link is fixed","body":"The drinks page is back."}' \g

-- 5. revoke, in one action
reset role;
set role authenticated;
select name, status, last_used_at is not null as used from agents;
select agent_status, agent_revoked_at is not null as revoked_at_set, agent_revoked_by
  from private.revoke_agent(:'agent_id');

-- 6. the same token, a moment later
reset role;
set role gaugeline_agent;
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind :menu_fixer_token 'a1000000-0000-4000-8000-0000000000a1' 'email' '{"subject":"Again","body":"Once more."}' \g

-- 7. the history: who changed what
reset role;
set role authenticated;
select from_status, to_status, changed_by from agent_events order by id;

-- 8. an agent owned by a freelancer who then leaves the agency
select agent_id is not null as registered from private.register_agent('0a000000-0000-4000-8000-00000000000a',
  'Weekly digest', '44444444-0000-4000-8000-000000000001', '{draft:email}');
delete from members where org_id = '0a000000-0000-4000-8000-00000000000a'
  and user_id = '44444444-0000-4000-8000-000000000001';
select name, owner_id, status, reasons from agent_shadow_inventory;

-- 9. a member who is not an owner or admin
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000002"}', false) is not null as signed_in;
select count(*) as agents_seen from agents;
```

```text
SET
 signed_in
-----------
 t
(1 row)

 token_shown_once | prefix_matches
------------------+----------------
 t                | t
(1 row)

    name    |              scopes              | status |   origin   | last_used_at
------------+----------------------------------+--------+------------+--------------
 Menu fixer | {draft:email,draft:pull_request} | active | registered |
(1 row)

ERROR:  the agent breaks the registry rule agents_scopes_known
CONTEXT:  PL/pgSQL function private.register_agent(uuid,text,uuid,text[]) line 52 at RAISE
ERROR:  an agent names each scope once
CONTEXT:  PL/pgSQL function private.agents_check_insert() line 10 at RAISE
SQL statement "insert into public.agents (org_id, name, owner_id, scopes, token_sha256, token_prefix)
        values (p_org, p_name, p_owner, coalesce(p_scopes, '{}'),
                pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_token, 'UTF8')), 'hex'),
                pg_catalog.substr(v_token, 5, 8))
        returning id"
PL/pgSQL function private.register_agent(uuid,text,uuid,text[]) line 29 at SQL statement
ERROR:  permission denied for table agents
ERROR:  permission denied for table agents
RESET
SET
 inserted
----------
 t
(1 row)

RESET
SET
    name    | status | used
------------+--------+------
 Menu fixer | active | t
(1 row)

 agent_status | revoked_at_set |           agent_revoked_by
--------------+----------------+--------------------------------------
 revoked      | t              | 11111111-0000-4000-8000-000000000001
(1 row)

RESET
SET
WARNING:  agent call denied: revoked
 inserted
----------
 f
(1 row)

RESET
SET
 from_status | to_status |              changed_by
-------------+-----------+--------------------------------------
             | active    | 11111111-0000-4000-8000-000000000001
 active      | revoked   | 11111111-0000-4000-8000-000000000001
(2 rows)

 registered
------------
 t
(1 row)

DELETE 1
     name      | owner_id | status |  reasons
---------------+----------+--------+------------
 Weekly digest |          | active | {no-owner}
(1 row)

 signed_in
-----------
 t
(1 row)

 agents_seen
-------------
           0
(1 row)
```

What it shows:

1. The owner registers the agent. The database mints the token and returns it once, and fills in the
   status, the creation time and no last use.
2. A scope that is not on the list, or one scope twice, is refused. The refusal names the rule, not the row.
3. Nobody signed in can insert a row (so nobody picks a token), set `last_used_at`, `created_at`,
   `revoked_at` or `revoked_by`, or read a token's hash.
4. The agent's draft is accepted, and that sets "last used" (so does an allowed read, AG-08). A person
   reading the registry does not.
5. **Revoke is one call**: `private.revoke_agent(id)` sets the status, the time and who did it in one
   statement and writes the history row. Revoking a revoked agent changes nothing.
6. The token stops working for the very next call: nothing is inserted, the agent is told `revoked`, and
   the refusal is in the [deny log](./agent-policy.md). A call that was already running when the revoke
   committed waits for it and is then refused.
7. Every status change is kept, with who made it and when. Nobody can change or delete that history.
8. The shadow-agent inventory flags the freelancer's agent: it has no owner any more.
9. A member who is not an owner or admin sees nothing.

A revoked agent cannot be switched back on, renamed or given new scopes: register a new one, which gets a
new token. An agent's owner cannot be cleared by hand while they are still staff: name another owner
instead. The owner is cleared only when they leave the organisation (or stay on as a client viewer). To pause an agent instead, set its status to `disabled` and back to `active` later. Both changes
are in the history.

## Shadow agents: the inventory

An agent nobody answers for is a risk even if it never misbehaves: nobody notices when it should have
been switched off. The view `agent_shadow_inventory` lists every agent that can still act (`active` or
`disabled`) and has at least one of these reasons:

- `no-owner`: it never had one (a token from before the registry), or its owner left the organisation;
- `owner-not-staff`: its owner is now a client viewer;
- `unused-30-days`: no accepted draft for 30 days, or none since it was registered 30 days ago.

30 days is `SHADOW_IDLE_DAYS` in `apps/hosted/agents/registry.ts`, and a test keeps it equal to the view.
The list is a prompt to act, not an action: a flagged agent keeps working until an owner or admin gives
it an owner or revokes it. Revoked agents are never listed.

## Agent tokens from before the registry

Before the registry, an organisation's agent was a hashed token with no name, owner or scopes. The
migration moves each one in, unchanged: same organisation, same hash, same creation time, and revoked if it
was revoked. Each gets the name "Agent token" and a number, the three draft scopes it could already use
(so nothing that worked stops working), no owner and no prefix, so every one of them appears in the shadow
inventory with `no-owner` until someone owns or revokes it. Such a row is marked `origin = migrated_0005`.
That is the only kind of row without a prefix: every agent registered afterwards has one, and no later row
can be marked as migrated.

## What it does not do yet

- The two `read:` scopes are enforced (AG-08): a call without the scope is refused with `scope` and logged.
  An allowed read sets "last used" too, so an agent that only reads is not flagged as unused.
- Per-agent tool allowlists, rate limits, cost ceilings, timeouts and kill switches are on
  [agent policy and limits](./agent-policy.md) (AG-03); per-call traces are AG-05. ADR-0014 ("Agent
  safety model") lists the threats each one answers.
- There is no page for the registry yet; it is the next step (a list, register and revoke under the
  organisation's settings, for owners and admins).
- An agent run entirely on someone's own machine against the local MCP server is not in the registry: the
  registry is the inventory of hosted agents only.
- Like decisions and drafts, the history cannot be deleted, so an organisation that ever registered an
  agent cannot be deleted by the app ([data model](./data-model.md)).

What the owner sets up: nothing new. The agent's database login stays a member of `gaugeline_agent` only
(`agentLoginsWithOtherRoles` in `apps/hosted/db/audit.ts` must stay empty).
