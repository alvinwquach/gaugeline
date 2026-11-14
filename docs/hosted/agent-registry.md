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

The scopes are one per kind of draft and four reads. None of them writes: agents only draft, and only
your own worker applies an approved draft ([applying an approved fix](./writer.md)).

| Scope                | Lets the agent                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `draft:pull_request` | propose a pull request                                                                                                      |
| `draft:email`        | propose an email                                                                                                            |
| `draft:sanity_draft` | propose a Sanity draft document                                                                                             |
| `read:runs`          | read one site's run history at a time ([`GET /api/v1/runs?site=`](./api.md#agent-reads-pending-drafts-and-run-history))     |
| `read:pending`       | list the drafts waiting for a decision (`GET /api/v1/drafts?status=pending`)                                                |
| `read:notes`         | name the [field-findings miner](../field-findings-miner.md)'s one read, a folder of review notes (registry only, see below) |
| `read:rules-file`    | name the [house-rules compiler](../house-rules.md)'s one read, a style-guide file (registry only, see below)                |

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
are in the history. To end a token on a date, see [token expiry](#token-expiry).

## Token expiry

By default an agent's token does not expire; you stop it by revoking or disabling it. If you would rather
a token ends on its own (a contractor's agent for a month, a trial), give the agent an expiry time. Past
that time the token is refused exactly like a disabled agent's: the call inserts nothing, uses none of the
agent's rate limit or cost allowance, does not count as "last used", and is written to the
[deny log](./agent-policy.md) and the [trace](./agent-trace.md) with the reason `disabled`. Nothing in the
answer, the log or the trace says the token "expired": the reason is one of the eleven that already existed,
so the answer tells a caller nothing it did not know about a disabled agent. The scorecard
([agent scorecard](./agent-scorecard.md)) shows such an agent as `expired` instead of `active`, so it is
not mistaken for one that is working.

- **No expiry is the default**, and every agent that existed before this was added has none: nothing about
  them changed.
- **One call sets or clears it**: `private.set_agent_expiry(agent, time, allow_past)`, for an owner or admin
  of the agent's organisation, like `private.revoke_agent`. There is no new role and no new login. Another
  organisation's agent reads "agent not found". The agent's own database role cannot call it, so a token
  cannot extend itself, and nobody signed in can write the column directly.
- **A time in the past is refused** unless you pass `allow_past` as `true`: that ends the token now, which
  is something to do on purpose and not with a mistyped date. `infinity` is refused too: clear the expiry
  (`null`) for a token that never expires.
- **It can be brought back**: setting a later time, or `null`, makes the same token work again, which is
  why the reason is `disabled` and not `revoked`. A revoked agent's expiry cannot change: revoking is final.
- **The database's own clock decides.** Each call reads the clock as it makes the decision, so a long
  transaction cannot keep an expired token alive. The server's clock and the database's are never compared.
- It is **not recorded in the history**: the registry history (`agent_events`) keeps statuses. The expiry on
  the row is the current one.

An example on the seeded test database (the same set-up as above, with migration `0018_agent_token_expiry.sql`
applied): the owner registers the menu fixer, gives it 30 days, tries a date in the past by mistake, ends the
token on purpose, and gives it back.

```sql
-- Northgate Studio's owner, signed in
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000001"}', false) is not null as signed_in;

-- 1. register an agent: no expiry unless you set one
select agent_id, token as menu_fixer_token
  from private.register_agent('0a000000-0000-4000-8000-00000000000a', 'Menu fixer',
                              '11111111-0000-4000-8000-000000000001', '{draft:email}') \gset
select name, status, expires_at from agents;

-- 2. a token for 30 days
select agent_expires_at > now() as expires_in_the_future
  from private.set_agent_expiry(:'agent_id', now() + interval '30 days');

-- 3. a time already past is refused, unless you mean it
select * from private.set_agent_expiry(:'agent_id', now() - interval '1 day');

-- 4. the agent drafts before the expiry
reset role;
set role gaugeline_agent;
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind :menu_fixer_token 'a1000000-0000-4000-8000-0000000000a1' 'email' '{"subject":"Your menu link is fixed","body":"The drinks page is back."}' \g

-- 5. the agent cannot move its own expiry
select private.set_agent_expiry(:'agent_id', null);

-- 6. end the token now, on purpose
reset role;
set role authenticated;
select agent_expires_at <= now() as already_passed
  from private.set_agent_expiry(:'agent_id', now(), true);

-- 7. the same token, a moment later
reset role;
set role gaugeline_agent;
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind :menu_fixer_token 'a1000000-0000-4000-8000-0000000000a1' 'email' '{"subject":"Again","body":"Once more."}' \g

-- 8. the refusal is in the deny log, as `disabled`
reset role;
set role authenticated;
select reason from agent_denies order by id desc limit 1;

-- 9. a member who is not an owner or admin cannot give it back
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000002"}', false) is not null as signed_in;
select * from private.set_agent_expiry(:'agent_id', null);

-- 10. the owner clears the expiry: the same token works again
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000001"}', false) is not null as signed_in;
select agent_expires_at is null as never_expires from private.set_agent_expiry(:'agent_id', null);
reset role;
set role gaugeline_agent;
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind :menu_fixer_token 'a1000000-0000-4000-8000-0000000000a1' 'email' '{"subject":"Once more","body":"Back at work."}' \g
```

```text
SET
 signed_in
-----------
 t
(1 row)

    name    | status | expires_at
------------+--------+------------
 Menu fixer | active |
(1 row)

 expires_in_the_future
-----------------------
 t
(1 row)

ERROR:  that expiry is in the past and would end the token now; pass p_allow_past = true to do that on purpose
CONTEXT:  PL/pgSQL function private.set_agent_expiry(uuid,timestamp with time zone,boolean) line 25 at RAISE
RESET
SET
 inserted
----------
 t
(1 row)

ERROR:  permission denied for function set_agent_expiry
RESET
SET
 already_passed
----------------
 t
(1 row)

RESET
SET
WARNING:  agent call denied: disabled
 inserted
----------
 f
(1 row)

RESET
SET
  reason
----------
 disabled
(1 row)

 signed_in
-----------
 t
(1 row)

ERROR:  agent not found
CONTEXT:  PL/pgSQL function private.set_agent_expiry(uuid,timestamp with time zone,boolean) line 15 at RAISE
 signed_in
-----------
 t
(1 row)

 never_expires
---------------
 t
(1 row)

RESET
SET
 inserted
----------
 t
(1 row)
```

What it shows: a new agent has no expiry (1); a future time is accepted (2); a past time is refused unless
asked for (3); the agent drafts before it passes (4); the agent cannot call the function (5); ending the token
on purpose (6) makes its next call a refusal with the reason `disabled`, in the deny log (7, 8); a member
cannot undo it (9); the owner can (10).

## The two scopes for agents that read a local file

Two agents read a file on a person's own computer: the [field-findings miner](../field-findings-miner.md)
(`read:notes`) and the [house-rules compiler](../house-rules.md) (`read:rules-file`). Their descriptors name
that scope, so the registry's closed list holds it (migration `0019_agent_scopes_notes_rules.sql`). The
migration changes one rule of the list and nothing else: the two names are added and the most scopes an
agent can hold goes from 5 to 7. No role, login, grant, table or function is added, and no agent that was
registered before changes.

**Registering an agent with one of them lets it do nothing yet.** The policy's list of tools
([agent policy](./agent-policy.md)) does not name `read:notes` or `read:rules-file`, so a call with either is
refused as `tool-not-allowed` and logged, whatever scopes the agent holds. Adding a tool to the policy is its own
reviewed change; until then, the scope is how the owner records that the agent exists and what it would read.
Both agents run from the command line, on your own computer, and need no token there.

Northgate Studio registers both. This is the output of the seeded test database, run with `psql` 16 as written,
as the schema owner switching roles the way the app's login does:

```sql
-- Northgate Studio's owner, signed in (the app's login switches to `authenticated` with her claims)
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000001"}', false) is not null as signed_in;

-- 1. register the two agents; each gets the one scope that names the file it reads
select agent_id as miner_id, token as miner_token
  from private.register_agent('0a000000-0000-4000-8000-00000000000a', 'Field-findings miner',
                              '11111111-0000-4000-8000-000000000001', '{read:notes}') \gset
select agent_id as rules_id, token as rules_token
  from private.register_agent('0a000000-0000-4000-8000-00000000000a', 'House-rules compiler',
                              '11111111-0000-4000-8000-000000000001', '{read:rules-file}') \gset
select name, scopes, status from agents order by name;

-- 2. the list is still closed: a misspelling, and a scope that writes beside a good one
select agent_id from private.register_agent('0a000000-0000-4000-8000-00000000000a', 'Typo',
  '11111111-0000-4000-8000-000000000001', '{read:note}');
select agent_id from private.register_agent('0a000000-0000-4000-8000-00000000000a', 'Writer',
  '11111111-0000-4000-8000-000000000001', '{read:notes,write:rules-file}');

-- 3. another agency's owner, signed in, sees none of this organisation's agents
select set_config('request.jwt.claims', '{"sub":"22222222-0000-4000-8000-000000000001"}', false) is not null as signed_in;
select count(*) as agents_seen from agents;

-- 4. the policy still refuses both tools, scope or no scope (run as the schema owner: no login calls it)
reset role;
select allowed, reason from private.agent_authorize(:'miner_token', 'read:notes', 0);
select allowed, reason from private.agent_authorize(:'rules_token', 'read:rules-file', 0);
select tool, reason from agent_denies order by id;
```

```text
SET
 signed_in
-----------
 t
(1 row)

         name         |      scopes       | status
----------------------+-------------------+--------
 Field-findings miner | {read:notes}      | active
 House-rules compiler | {read:rules-file} | active
(2 rows)

ERROR:  the agent breaks the registry rule agents_scopes_known
CONTEXT:  PL/pgSQL function private.register_agent(uuid,text,uuid,text[]) line 52 at RAISE
ERROR:  the agent breaks the registry rule agents_scopes_known
CONTEXT:  PL/pgSQL function private.register_agent(uuid,text,uuid,text[]) line 52 at RAISE
 signed_in
-----------
 t
(1 row)

 agents_seen
-------------
           0
(1 row)

RESET
WARNING:  agent call denied: tool-not-allowed
 allowed |      reason
---------+------------------
 f       | tool-not-allowed
(1 row)

WARNING:  agent call denied: tool-not-allowed
 allowed |      reason
---------+------------------
 f       | tool-not-allowed
(1 row)

 tool |      reason
------+------------------
      | tool-not-allowed
      | tool-not-allowed
(2 rows)

```

What it shows:

1. Each agent is registered with its one scope; the database mints a token for each, as for any agent.
2. The list is still closed: a misspelling and a scope that writes are refused, and the refusal names the rule,
   not the row.
3. Another agency's owner, signed in, sees none of this organisation's agents.
4. The policy refuses both tools. The deny log holds the reason and no tool name: only a name on the policy's own
   list is ever stored, never what a caller typed.

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

- The `read:notes` and `read:rules-file` scopes are accepted by the registry but not enforced anywhere
  yet: the policy does not list their tools, so they are refused (above).
- The `read:pending` and `read:runs` scopes are enforced (AG-08): a call without the scope is refused with `scope` and logged.
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
