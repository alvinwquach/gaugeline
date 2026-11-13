# Hosted: the red-team suite for agents

The hosted version of Gaugeline (in progress, not released) lets a registered agent propose a fix as a
draft that a person approves ([the inbox](./inbox.md), [the agent registry](./agent-registry.md), [agent
policy and limits](./agent-policy.md)). This page is about the tests that try to get an agent, or a
person's approval, to do something it must not, and check that the system **fails closed**: the call is
refused, nothing is written, nothing is leaked.

The suite is test code only. It changes no migration, guard, limit or allowlist, and adds no role or table.
Each case is named for one attack and for the threat in
[ADR-0014](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0014-agent-safety-model.md) it covers
(T1 to T12). If a case ever passes open, the right fix is in the control, never in the test.

## The attacks, and what stops each one

An example: an agency works for a cocktail bar and a physiotherapy clinic and registers one agent for each.
The cross-tenant case checks that the bar's agent cannot draft into, read or even detect the clinic's
site, and the double-click case checks that a nervous second press on "Approve" does not send the bar's
menu email twice.

| Case                                                                                                                      | Threat  | What stops it                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| **Double-click approve.** Five approvals of one draft at once.                                                            | T4      | One decision per draft (a unique index); the others are told who decided. One decision, one job.      |
| **Replayed approval.** An approval sent again, or a decline after it, even straight at the table.                         | T3      | The same index, and decisions are append-only. Nothing is written or queued.                          |
| **Approval of an edited draft.** The draft changed after review, or an edit sent after approval.                          | T5      | Drafts are append-only; the database hashes the payload at the decision; the job carries that hash.   |
| **Cross-tenant token.** One agency's agent drafts into, names a finding of, or reads from another agency's site.          | T6      | The agent's organisation comes from its token's registry row, never from the call. Reads find none.   |
| **Revoked agent.** An agent revoked a moment ago calls again, and an unknown token calls.                                 | T10     | Only an active registry row is recognised; the refusal is logged with its reason and writes nothing.  |
| **Expired token.** An agent token past an expiry date.                                                                    | T10     | Not built: agent tokens have no expiry. Listed as a pending case below.                               |
| **Cost-cap breach.** A call that would take the agent past its day's ceiling, a negative cost, a cost over 10^12.         | T7      | `private.agent_authorize` checks the declared cost first; a refused call is not counted.              |
| **Runaway loop.** More calls than the window allows.                                                                      | T7      | The per-agent rate limit; the call after the last place inserts nothing.                              |
| **Oversized input.** 51 findings, a payload over 16 KiB, a 201-character token.                                           | T7, T9  | The entry's own limits and the token length bound.                                                    |
| **Malformed tool output.** A draft with an unknown key, a wrong type, a bidirectional control or a line break in a title. | T9      | The database checks each kind's fixed shape when a draft is written.                                  |
| **Kill switch.** The operator's global switch, and `GAUGELINE_AGENTS_OFF` set to `1`, empty, `true` or garbage.           | T7, T12 | The database switch; in the process, any value but unset or `0` stops, before the database is called. |

**Pending (`it.todo`).** _Expired token_ (T10) waits for a decision: the registry has no expiry on an agent's
token, only revoke, `disabled` and a flag for a token unused for 30 days. The next pull request adds the
cases for page text, the MCP server and the writer (injection, malformed answers, an expired or replayed
approval at the worker).

## Run it

The cases need a Postgres 16 server. Point the tests at one you can throw away:

```sh
$ export GAUGELINE_TEST_DATABASE_URL=postgres://postgres:gaugeline-test@127.0.0.1:5432/postgres
$ pnpm exec vitest run apps/hosted/db/__tests__/red-team.test.ts
 ✓ red team: the hosted database (T2 to T10) > double-click approve: the same draft approved five times at once writes one decision and one job
 ✓ red team: the hosted database (T2 to T10) > revoked agent: its next call is refused, logged as revoked, and writes nothing
 □ red team: the hosted database (T2 to T10) > expired token: an agent token past its expiry is refused (no control yet: agents have no expiry column; needs an owner decision)
 ...
 Test Files  1 passed (1)
      Tests  11 passed | 1 todo (12)
```

Without the variable the cases are skipped, so the normal test run on Windows and macOS does not need a
server. CI's `hosted-db` job starts one and sets `GAUGELINE_REQUIRE_TEST_DATABASE=1`, which turns a missing
server into a failure. The tests use fixed invented data and read no clock.
