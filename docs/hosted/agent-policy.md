# Hosted: agent policy and limits

The hosted version of Gaugeline (in progress, not released) lets a registered agent propose a fix as a
draft that a person approves ([the inbox](./inbox.md), [the agent registry](./agent-registry.md)). Every
call an agent makes is first checked against **its policy**: which tools it may call, how often, how much
it may spend, how long the call may take, and whether anyone has stopped it. The check runs in the
database, before the call does anything, and **denies by default**. Every refusal is written to a log your
owners and admins can read, with the reason.

**Planned (part 2), not in this version:** a TypeScript policy module that makes the same deny-by-default
decision, with the same reasons, before an agent's call is sent, and kill switches read from the
environment at every call, so the operator can stop agents without a database change. Neither exists yet:
today every check on this page is made in the database.

## What the policy checks, in order

One function, `private.agent_authorize(token, tool, cost)`, decides every agent call. The agent's draft
entry (`private.agent_insert_draft`) calls it first, on the token and the tool name alone (`draft:email`
for an email draft), before it looks at the site, the findings or the payload. The read tool that lists
pending drafts (AG-08) will call the same function. The first rule that applies is the reason:

| Reason               | When                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `unknown-agent`      | the token matches no agent                                                                         |
| `revoked`            | the agent was revoked; this wins over every other reason                                           |
| `kill-switch-global` | the operator has stopped every agent (below)                                                       |
| `disabled`           | an owner or admin set the agent's status to `disabled`                                             |
| `kill-switch-agent`  | the operator has stopped this one agent                                                            |
| `bad-input`          | the call names no tool, or declares a cost that is missing, negative or over 10^12                 |
| `tool-not-allowed`   | the tool is not on the closed list (the registry's scopes); nothing that writes is on it           |
| `scope`              | the tool is on the list, but the agent's scopes do not name it. A new agent has no scope           |
| `timeout`            | the call cannot finish within the agent's timeout (it waited too long for a lock, or ran too long) |
| `rate-limit`         | the agent has used all its calls for the current window                                            |
| `cost-ceiling`       | the call's declared cost would take the agent over its ceiling for the day (UTC)                   |

A refused call inserts nothing and returns null. The agent gets a warning that names the reason
(`agent call denied: rate-limit`) and nothing else; it is not told about the site or the payload.

**Cost, today.** No agent call runs a model yet, so a draft declares a cost of 0. The ceiling counts
whatever cost units a call declares, as whole micro-units (10^6 to the unit, integers, never decimals),
so it starts to matter when model calls declare theirs (AG-22). A missing or negative cost is refused,
never treated as free.

## The limits, and who sets them

Each agent has one row in `agent_limits`, created with it:

| Limit                 | Default         | Range           |
| --------------------- | --------------- | --------------- |
| `calls_per_window`    | 10              | 0 to 10000      |
| `window_seconds`      | 60              | 1 to 86400      |
| `cost_ceiling_micros` | 1000000 per day | 0 to 10^12      |
| `timeout_ms`          | 5000            | 100 to 60000 ms |

Only an owner or admin of the agent's organisation can read or change them, and only these four columns.
The counters (calls in the current window, cost spent today) and the timestamps are the database's. Every
change, and the starting values, go to `agent_limit_events` with who made the change and when; nobody can
change or delete that history. A revoked agent's limits cannot change. `calls_per_window = 0` stops an
agent without touching its status.

Two calls at once cannot both take the last place: the policy locks the agent's row and its limits row for
the rest of the call, so calls of one agent are counted one after the other. The window is fixed (it
starts at the first call after the last window ended), so a burst across the edge of two windows can reach
twice the limit.

A refused call uses no place in the window and no cost. That holds for a `timeout` that comes after the
policy let the call through (it waited past its deadline for the site's lock, or its draft landed late):
the counted call is undone with the draft, and the deny row holds the counters as they are once it is.

## An example: the menu fixer, limited and stopped

Northgate Studio's owner registers an agent that drafts emails about The Tidewater Bar's menu, allows it
two calls a minute, and watches what it is refused. Then the operator throws the global kill switch. This
is the output of the seeded test database (`apps/hosted/db/__tests__/harness.ts` and migrations
`0012_agent_registry.sql` and `0013_agent_policy.sql`), run with `psql` 16 as written, as the schema owner
switching roles the way the app's and the agent's logins do:

```sql
-- Northgate Studio's owner, signed in (the app's login switches to `authenticated` with her claims)
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000001"}', false) is not null as signed_in;

-- 1. register the menu fixer with one scope; its limits start at the defaults
select agent_id, token as menu_fixer_token
  from private.register_agent('0a000000-0000-4000-8000-00000000000a', 'Menu fixer',
                              '11111111-0000-4000-8000-000000000001', '{draft:email}') \gset
select calls_per_window, window_seconds, cost_ceiling_micros, timeout_ms
  from agent_limits where agent_id = :'agent_id';

-- 2. allow two calls a minute
update agent_limits set calls_per_window = 2 where agent_id = :'agent_id';

-- 3. the agent's calls (the agent's own role)
reset role;
set role gaugeline_agent;
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind :menu_fixer_token 'a1000000-0000-4000-8000-0000000000a1' 'email' '{"subject":"Your menu link is fixed","body":"The drinks page is back."}' \g
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind :menu_fixer_token 'a1000000-0000-4000-8000-0000000000a1' 'pull_request' '{"title":"Fix the menu link"}' \g
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind :menu_fixer_token 'a1000000-0000-4000-8000-0000000000a1' 'publish_now' '{}' \g
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind :menu_fixer_token 'a1000000-0000-4000-8000-0000000000a1' 'email' '{"subject":"Happy hour moved","body":"Now 5 to 7."}' \g
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind :menu_fixer_token 'a1000000-0000-4000-8000-0000000000a1' 'email' '{"subject":"Third","body":"One too many."}' \g

-- 4. the operator's global kill switch (the schema owner), then lifted
reset role;
insert into private.agent_switches (agent_id) values (null);
set role gaugeline_agent;
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind :menu_fixer_token 'a1000000-0000-4000-8000-0000000000a1' 'email' '{"subject":"During the stop","body":"Refused."}' \g
reset role;
delete from private.agent_switches where agent_id is null;

-- 5. the owner reads the deny log and the history of the limits
set role authenticated;
select tool, reason, window_calls from agent_denies order by id;
select calls_per_window, window_seconds, cost_ceiling_micros, timeout_ms, changed_by
  from agent_limit_events order by id;

-- 6. a member who is not an owner or admin
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000002"}', false) is not null as signed_in;
select count(*) as denies_seen from agent_denies;
update agent_limits set calls_per_window = 100;
```

```text
SET
 signed_in
-----------
 t
(1 row)

 calls_per_window | window_seconds | cost_ceiling_micros | timeout_ms
------------------+----------------+---------------------+------------
               10 |             60 |             1000000 |       5000
(1 row)

UPDATE 1
RESET
SET
 inserted
----------
 t
(1 row)

WARNING:  agent call denied: scope
 inserted
----------
 f
(1 row)

WARNING:  agent call denied: tool-not-allowed
 inserted
----------
 f
(1 row)

 inserted
----------
 t
(1 row)

WARNING:  agent call denied: rate-limit
 inserted
----------
 f
(1 row)

RESET
INSERT 0 1
SET
WARNING:  agent call denied: kill-switch-global
 inserted
----------
 f
(1 row)

RESET
DELETE 1
SET
        tool        |       reason       | window_calls
--------------------+--------------------+--------------
 draft:pull_request | scope              |            1
                    | tool-not-allowed   |            1
 draft:email        | rate-limit         |            2
 draft:email        | kill-switch-global |            2
(4 rows)

 calls_per_window | window_seconds | cost_ceiling_micros | timeout_ms |              changed_by
------------------+----------------+---------------------+------------+--------------------------------------
               10 |             60 |             1000000 |       5000 | 11111111-0000-4000-8000-000000000001
                2 |             60 |             1000000 |       5000 | 11111111-0000-4000-8000-000000000001
(2 rows)

 signed_in
-----------
 t
(1 row)

 denies_seen
-------------
           0
(1 row)

UPDATE 0
```

What it shows:

1. A new agent gets the default limits. It has only the scope it was given.
2. The owner changes a limit; the change is in the history with her id.
3. The email is drafted. A pull request is refused (`scope`: the agent may draft emails only), and so is a
   tool that does not exist (`tool-not-allowed`; the made-up name is not stored). The second email uses the
   second call of the minute, and the third is refused (`rate-limit`). Refused calls do not count.
4. While the global switch is on, every call of every agent is refused (`kill-switch-global`).
5. The owner sees every refusal: the tool (when it is a real one), the reason and the count, and the
   history of the limits. No token, payload or text is in either.
6. A member who is not an owner or admin sees no refusal and changes no limit.

## The kill switches

- **One agent, by you:** set its status to `disabled` in the registry (back to `active` to resume), or
  revoke it for good. Both are in the agent's history.
- **One agent, by the operator:** `insert into private.agent_switches (agent_id) values ('<agent id>')`, as
  the schema owner; delete the row to lift it. Reason `kill-switch-agent`.
- **Every agent, by the operator:** `insert into private.agent_switches (agent_id) values (null)`; delete
  that row to lift it. Reason `kill-switch-global`. It is checked on every call, not cached.

Nobody signed in, the server, the worker and the agent can read or set the operator's switches; only the
schema owner can.

### The environment switch, in front of the database

The hosted code that takes an agent's draft (`apps/hosted/agents/draft.ts`, for the worker and the app) also
reads `GAUGELINE_AGENTS_OFF` from its own environment **at every call**. Set to anything but `0`, an empty or
misspelt value included, it refuses every agent call with `kill-switch-global` before the database is called:
no draft, no counted call, and no row in `agent_denies` (the database is not reached), so the refusal is
logged by that process instead. Unset it, or set it to `0`, and the next call goes through. Use it when the
database itself is the problem, or to stop agents without a database login; use the operator's switch above
when you want the refusal in the organisation's deny log.

When the database refuses, the same code reads the reason from the warning (only a reason on the closed list
above, from the policy's own warning) and hands its log one entry with the time, the tool and the reason:

```json title=Log entry untested="Printed by the test that throws the switch (agent-draft.test.ts)."
{
  "at": "2026-11-13T09:00:00.000Z",
  "agentId": null,
  "tool": "draft:email",
  "reason": "kill-switch-global"
}
```

**One authorization per call.** This code does not call `private.agent_authorize` itself: the draft
function calls it once, first, and counts the call once in the rate window and the day's cost. Calling it
again from the code would count every draft twice. A test drafts three times and reads the counter: 1, 2, 3;
a refusal leaves it where it was.

The agent id is null there on purpose: the code never looks the token up itself; the database's deny row holds
the ids. No token, payload, site or text is in it. A call refused for any other cause (another organisation's
site, a payload of the wrong shape) stays an error, as before.

The same switch and the same reasons govern the [MCP server](../mcp.md#the-agent-policy), which has no
database: there the policy runs in its own process (one budget for the server, the tools you allow).

### Today and planned

| Control                                   | Today                                                     | Planned                                       |
| ----------------------------------------- | --------------------------------------------------------- | --------------------------------------------- |
| Scopes, rate limit, cost ceiling, timeout | in the database, before every draft (this page)           | the read tools (AG-08) call the same function |
| Kill switch, one agent                    | registry status `disabled`; the operator's switch row     |                                               |
| Kill switch, every agent                  | the operator's switch row; `GAUGELINE_AGENTS_OFF`         |                                               |
| Every deny logged                         | `agent_denies` (database); the process's log (env switch) | per-call traces of allowed calls too (AG-05)  |
| Cost                                      | every draft declares 0                                    | model calls declare theirs (AG-22)            |
| An HTTP endpoint for agents               | none yet: the worker or app calls `createAgentDrafts`     | when the hosted API for agents ships          |

## What is logged

`agent_denies` holds one row per refused call: the organisation and agent ids, the tool (only a name on
the closed list; anything else is stored as empty), the reason, the declared cost, the calls in the
current window and the cost spent today, and the time. Nothing else: no token, prefix, payload, site or
finding. Owners and admins of the organisation read their own rows. A call with a token that matches no
agent belongs to no organisation, so its row is readable by the schema owner only. The log is
append-only, for everyone.

## What is still at risk

- An agent that wraps its call in its own transaction and rolls it back also rolls back its deny row
  (Postgres has no autonomous transactions). It gains nothing from that call either: nothing was inserted.
  A log written outside the caller's transaction is the job of the per-call traces (AG-05).
- An unknown token can add rows to the deny log as fast as it can call. They belong to no organisation,
  so no customer sees them; they are bounded by the database's connection limits only.
- A call refused for another reason after the policy allowed it (another organisation's site, a payload of
  the wrong shape, the 200-drafts cap) is an error, as before, and is not a deny: the error undoes the
  counted call too.
