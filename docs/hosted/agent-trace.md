# Hosted: the agent trace

The hosted version of Gaugeline (in progress, not released) lets a registered agent propose a fix as a
draft that a person approves ([the inbox](./inbox.md), [the agent registry](./agent-registry.md),
[agent policy and limits](./agent-policy.md)). Every agent call, and every person's approval or decline of
an agent's draft, leaves **one row in the agent trace**. The trace is append-only: nobody changes or removes
a row, the schema owner included. It holds ids, hashes, counts and codes, never what the agent sent or got
back.

## What is stored, and what is never stored

| Column          | What it holds                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `org_id`        | the organisation                                                                                                               |
| `agent_id`      | the agent's registry id                                                                                                        |
| `tool`          | the tool, only a name on the closed list (`draft:email` ...); a made-up name is stored as empty                                |
| `input_sha256`  | the SHA-256 of the call's arguments, the token left out (below); for an approval, the hash of the approved payload             |
| `output_sha256` | the SHA-256 of what the call returned (the new draft's id); empty for a refused call                                           |
| `latency_ms`    | whole milliseconds: how long the call ran, or for an approval or decline, how long the draft waited for the person             |
| `tokens`        | tokens used, an integer. Always 0 today: no agent call runs a model. The column is there for the model layer (AG-19 and later) |
| `cost_micros`   | cost in integer micro-units (10^6 to the unit). Always 0 today, for the same reason                                            |
| `decision`      | `allowed`, `denied`, `approved` or `declined`                                                                                  |
| `reason`        | for `denied` only: the reason from the policy's closed list ([agent policy](./agent-policy.md))                                |
| `approver_id`   | for `approved` and `declined` only: the member who decided, in the inbox or in chat                                            |
| `draft_id`      | the draft the call created or the person decided                                                                               |
| `at`            | when                                                                                                                           |

**Never stored:** the agent's token or its prefix, the payload, a subject, a body, a diff, a site address,
a finding's text, an email address, or any text the agent or a page wrote. The tool is the only name, and
only from the closed list. A hash cannot be turned back into the input; it lets you prove later that a
draft is the one an agent sent (compare it with the draft's own hash), without the trace holding it.

**The input hash**: every argument of the call except the token, as one JSON object in Postgres's own
`jsonb` text (keys in a fixed order, so the same call always gives the same text), in Unicode NFC (so
`Café` typed two ways hashes the same), UTF-8, SHA-256, hex. Integers throughout: no floats, no rounding.

## Who reads it

Owners and admins of the organisation read their own rows. A member, a client viewer, another
organisation, nobody signed in, the server, the worker and the agent read nothing. Nobody signed in
inserts a row: one function, `private.agent_trace_record`, writes it, and only the agent's draft entry and
the decisions trigger call it. The agent's login still holds no privilege on any table and runs one
function.

## When a row is written

- **Every draft call**, in the same transaction as the call: `allowed` with the new draft's id, or
  `denied` with the reason. A refused call still writes its trace row and still inserts no draft.
- **Every read** of pending drafts or of a site's runs ([AG-08's reads](./agent-registry.md)): `allowed`
  with the hash of the answer, or `denied` with the reason. The answer itself is not stored.
- **Every approval or decline of an agent's draft**, from the inbox or from a chat button (both record the
  decision the same way): `approved` (an approval of an edited draft counts as approved) or `declined`,
  with the member who decided. A person's own draft is not an agent call and has no trace row.

## Bounded

The trace cannot be grown without limit by someone hammering it:

- **A token that matches no agent** belongs to no organisation, so it gets no row of its own. Those calls
  are counted in **one row a minute** of `agent_trace_overflow` (reason `unknown-agent`), which only the
  schema owner reads.
- **An agent's refused calls past 60 in one minute** are counted in `agent_trace_overflow` too, one row per
  reason per minute, which the organisation's owners and admins read. Its allowed calls are already bounded
  by its rate limit.

## An example: the menu fixer's trace

Northgate Studio's owner registers an agent that drafts emails about The Tidewater Bar's menu. It drafts
one email, is refused a pull request and a read of pending drafts, and someone tries a made-up token twice. The owner approves the
email and reads the trace. This is the output of the seeded test database
(`apps/hosted/db/__tests__/harness.ts` and migrations up to `0015_agent_trace.sql`), run with `psql` 16 as
written, as the schema owner switching roles the way the app's and the agent's logins do:

```sql
-- Northgate Studio's owner, signed in (the app's login switches to `authenticated` with her claims)
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000001"}', false) is not null as signed_in;

-- 1. register the menu fixer with one scope
select agent_id, token as menu_fixer_token
  from private.register_agent('0a000000-0000-4000-8000-00000000000a', 'Menu fixer',
                              '11111111-0000-4000-8000-000000000001', '{draft:email}') \gset

-- 2. the agent's calls (the agent's own role): one allowed, one refused, a read it has no scope for, two with a made-up token
reset role;
set role gaugeline_agent;
select private.agent_insert_draft($1, $2, $3, $4) as draft_id
  \bind :menu_fixer_token 'a1000000-0000-4000-8000-0000000000a1' 'email' '{"subject":"Your menu link is fixed","body":"The drinks page is back."}' \gset
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind :menu_fixer_token 'a1000000-0000-4000-8000-0000000000a1' 'pull_request' '{"title":"Fix the menu link"}' \g
select private.agent_list_pending($1) as pending \bind :menu_fixer_token \g
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind 'gla_00000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 'a1000000-0000-4000-8000-0000000000a1' 'email' '{}' \g
select private.agent_insert_draft($1, $2, $3, $4) is not null as inserted
  \bind 'gla_00000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' 'a1000000-0000-4000-8000-0000000000a1' 'email' '{}' \g

-- 3. the owner approves the draft in the inbox
reset role;
set role authenticated;
insert into decisions (org_id, draft_id, decision, decided_by)
  values ('0a000000-0000-4000-8000-00000000000a', :'draft_id', 'approved', '11111111-0000-4000-8000-000000000001');

-- 4. the owner reads the trace
select tool, decision, reason, left(input_sha256, 12) as input, left(output_sha256, 12) as output,
       latency_ms >= 0 as timed, tokens, cost_micros, approver_id
  from agent_trace order by id;
select count(*) as unknown_rows_seen from agent_trace_overflow;

-- 5. the schema owner sees the made-up tokens as one counter for the minute
reset role;
select reason, calls from agent_trace_overflow where agent_id is null;

-- 6. a member who is not an owner or admin, then a change of a row
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000002"}', false) is not null as signed_in;
select count(*) as trace_rows_seen from agent_trace;
reset role;
update agent_trace set tokens = 1;
```

```text
SET
 signed_in
-----------
 t
(1 row)

RESET
SET
WARNING:  agent call denied: scope
 inserted
----------
 f
(1 row)

WARNING:  agent call denied: scope
                pending
---------------------------------------
 {"reason": "scope", "allowed": false}
(1 row)

WARNING:  agent call denied: unknown-agent
 inserted
----------
 f
(1 row)

WARNING:  agent call denied: unknown-agent
 inserted
----------
 f
(1 row)

RESET
SET
INSERT 0 1
        tool        | decision | reason |    input     |    output    | timed | tokens | cost_micros |             approver_id
--------------------+----------+--------+--------------+--------------+-------+--------+-------------+--------------------------------------
 draft:email        | allowed  |        | 96a5b841d3f0 | 5d871dbaee8b | t     |      0 |           0 |
 draft:pull_request | denied   | scope  | 202f45d8ea9d |              | t     |      0 |           0 |
 read:pending       | denied   | scope  | 980a40e6a5d1 |              | t     |      0 |           0 |
 draft:email        | approved |        | 95d14ada0482 |              | t     |      0 |           0 | 11111111-0000-4000-8000-000000000001
(4 rows)

 unknown_rows_seen
-------------------
                 0
(1 row)

RESET
    reason     | calls
---------------+-------
 unknown-agent |     2
(1 row)

SET
 signed_in
-----------
 t
(1 row)

 trace_rows_seen
-----------------
               0
(1 row)

RESET
ERROR:  agent_trace is append-only: UPDATE is not allowed
HINT:  Insert a new row instead (a later decision, a withdrawal).
CONTEXT:  PL/pgSQL function private.refuse_change() line 3 at RAISE
```

What it shows:

1. One row per call: the allowed email (with the hash of its input and of the draft id it returned), the
   refused pull request and the refused read (the reason, no output), and the owner's approval (the approved payload's hash and
   her id). Tokens and cost are 0: nothing ran a model. The output hash differs on every run (it is the
   hash of a new draft id); the input hashes do not.
2. The made-up tokens left no row in the trace, only a count for the minute, which only the schema owner
   reads.
3. A member who is not an owner or admin sees nothing, and nobody, the schema owner included, changes a
   row.

## What is still at risk

- **A call that raises is undone whole.** A call refused by an error after the policy let it through
  (another organisation's site, a payload of the wrong shape, the 200-drafts cap) leaves no trace row,
  just as it leaves no draft and no counted call. Postgres has no autonomous transactions.
- **An agent that wraps its call in its own transaction and rolls it back** rolls back its trace row too.
  It gains nothing from that call either: nothing was inserted.
- **The hash is not redacted.** The hosted input hash is taken over the call's arguments as the database
  received them, because the draft itself is stored, as sent, in the drafts table for the person to
  review; the trace adds nothing to read.
- **The bound is per minute and soft under concurrency.** Two refused calls of one agent at the same
  instant may each see 59 rows and both write one.
- **The deny log** ([agent policy](./agent-policy.md)) still writes one row per unknown-token call; the
  trace does not. Bounding that log is a change to 0013's policy function, left for its own branch.
