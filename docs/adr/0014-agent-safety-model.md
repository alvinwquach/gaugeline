# ADR-0014: Agent safety model: registered agents, drafts only, deny by default, every call traced

Status: accepted Date: 2026-11-13

**Accepted by the owner on 13 Nov 2026.** This record changes no code, no flag and no line of CLAUDE.md.
Row AG-04 of batch AG. The batch calls it "ADR-0011"; 0011 to 0013 are taken (#251), so it is 0014. It changes
neither ADR-0005 nor ADR-0010: where a later row needs either changed, it says so under "What would change
it". ADR-0005 has since been amended by the owner for model providers (modes 1 and 2); see that record.

## Context

### What an agent is in Gaugeline

An agent is any program that calls Gaugeline on someone's behalf and may be steered by text it did not
write. Today there are four, and batch AG adds more:

1. **The MCP server's callers** (`packages/mcp`). An assistant starts `gaugeline-mcp` and gets six tools,
   five `read` and one `draft` (`draft_fix`, text only); no tool approves, applies or writes
   (`packages/mcp/src/registry.ts`, test `registry.test.ts`, "offers no tool that approves, applies,
   writes, publishes or deploys"). Over HTTP one operator token (`GAUGELINE_MCP_TOKEN`) covers every
   caller; it is not a per-agent identity.
2. **The hosted agent's draft entry** (G37, #319). The database role `gaugeline_agent` holds no privilege
   on any table; its one way in is `private.agent_insert_draft(token, site, kind, payload, finding_ids)`,
   which finds the organisation from the SHA-256 of the token (`private.agent_tokens`), refuses another
   organisation's site or finding, checks the kind's shape, and caps a draft at 50 findings and a site at
   200 waiting drafts (`apps/hosted/db/migrations/0005_drafts_inbox.sql`). The token table has an
   organisation, a hash, `created_at` and `revoked_at`: no name, owner, scopes or last use.
3. **The chat approval path** (X69 part 1, #359; part 2 is #365, open). A signed Slack request becomes
   the inbox's own decision row through `private.chat_decide`, run by a login that is a member of
   `gaugeline_chat` only (`docs/hosted/chat-approvals.md`).
4. **The writer** (`packages/writer`, #321, #356). Not a model: the customer's worker, which turns one
   approved draft into one draft pull request or one Gmail draft with the customer's own credential, after
   re-checking the approval (ADR-0010).

Batch AG adds: an agent registry (AG-02), per-agent policy and kill switches (AG-03), traces (AG-05),
receipts (AG-06), a scorecard (AG-07), a read-only pending-approvals tool (AG-08), evals and a red-team
suite (AG-09 to AG-11), draft-only agents (AG-12 to AG-18), and a model layer with recorded fakes and
bring-your-own-key (AG-19 to AG-25).

### What already holds

- **Page text is labelled data.** N17 (#243, #258) and AG-01 part 1 (#368): every title, evidence line and
  address from a page reaches an assistant as a field marked `untrusted: true` with its source,
  cleaned of control and hidden characters and capped (`packages/core/src/untrusted.ts`,
  `packages/mcp/src/agent-text.ts`); errors repeat only id-shaped values. AG-01 part 2 (#374, open)
  walks a hostile page through every tool.
- **Checks never call a model** (ADR-0002, `no-model-calls.test.ts`).
- **One decision per draft, append-only**: a unique index on `decisions (draft_id)` for the three choices;
  the database computes the payload hash (#319).
- **The writer trusts nothing in the job**: approval row, organisation, site, kind, hash, withdrawal, a
  72-hour expiry, shape and registry, then the two stop switches before every request (#321,
  `packages/writer/src/__tests__/approval.test.ts`).

### What forced a decision

The batch rows each add one control. Without one model, each row would choose its own idea of who an
agent is, what "denied" means and what is logged. This record names the threats once, the control for
each, the test that proves it, and what stays at risk, so the rows have one list to build against and a
reviewer has one list to check.

## Decision

Gaugeline's agents are **registered, limited, traced and draft-only**. An agent exists only as a row in
the registry with an owner and scopes (AG-02); every call is checked in code against that agent's
allowlist, limits and kill switches before it runs, and is denied by default (AG-03); every call,
allowed or denied, is traced append-only with secrets and personal data removed first (AG-05); every
approved draft gets a hash-chained receipt that anyone can verify offline (AG-06). Agents only draft:
there is no write tool, and the only writes are ADR-0010's, after a person's recorded approval, in the
customer's worker. Grouping, ranking, diffing and checking are plain code; a model, where used at all,
only words a draft, behind one interface with a recorded fake (AG-19), and a model-judged result never
gates a build and never says pass. Gaugeline stores no model key (AG-20 modes 1 and 2). Page text is data,
never an instruction (AG-01). Each control must fail closed, and a red-team suite proves it (AG-10).

### 1. The threats, and the control for each

Each entry: the threat in plain words; the control today (file, PR) or planned (row); the test that
proves it, or "none yet"; what stays at risk. The OWASP ids are from the 2025 list (Sources); each
mapping is this record's reading of that list, not OWASP's.

**T1. Prompt injection through page text** (LLM01:2025, "indirect prompt injections").

- Threat: a checked page carries words aimed at the assistant ("ignore your instructions", text hidden by
  CSS, Unicode tag characters), and the assistant obeys them.
- Today: page text leaves the engine only as a labelled, cleaned, capped field; it never appears in a tool
  name, description or error (#243, #258, #368). The writer escapes it for Markdown and never uses it as a
  path, branch, recipient or subject (ADR-0010 part 8, #321). The check `hidden-ai-directive` reports
  such text on the page.
- Planned: AG-01 parts 2 and 3 (hostile fixture through every tool); AG-23 sends a model findings,
  snippets and ids only; AG-10 case "prompt injection via page text".
- Test: `packages/core/src/__tests__/untrusted.test.ts`, `untrusted-output.test.ts`,
  `packages/mcp/src/__tests__/agent-text.test.ts`, `registry.test.ts` ("never puts page text in a tool
  name or description").
- Residual: labelling does not make a model obey the label. The safety comes from what the agent can do
  after reading (drafts only, a person approves the exact payload), not from the label.

**T2. Confused deputy** (LLM06:2025, "excessive permissions"; "execute extensions in user's context").

- Threat: a program acts with a person's authority for someone who does not have it.
- Found and fixed: X69's credential review of #359 (finding 1) showed the chat login was also a member
  of `authenticated`, so it "could set another person's claims, `set role authenticated`, read other
  organisations' drafts and write a decision in that person's name". Finding 2: "An admin could link any
  chat user to the owner." Now the login is `gaugeline_chat` only, `chat_decide` resolves the member
  itself from a link the member confirmed, and the caller never names a member.
- Today also: the agent role cannot decide (no privilege on `decisions`, #319); an agent's draft is "in
  nobody's name"; the writer acts only on an approval row it reads itself (#321).
- Found by this record, not fixed: `ownerConsent: true` on `run_check` is a tool argument, so the model
  sets it, not the site's owner (`packages/mcp/src/registry.ts`). It is per call and never remembered,
  but nothing proves a person said yes.
- Planned: AG-02 scopes per agent; AG-03 refuses a tool outside the agent's allowlist; AG-05 records the
  approver; AG-10 cases "cross-tenant token", "revoked agent".
- Test: `apps/hosted/db/__tests__/chat.test.ts` ("setting a victim's claims and switching to
  authenticated is refused", "chat_decide takes no member from the caller"), `inbox.test.ts` ("a
  signed-in person cannot use the agent's way in"). For `ownerConsent`: none yet.
- Residual: a full compromise of the chat endpoint can record an approval for any confirmed, allowed
  member of a connection it knows (docs/hosted/chat-approvals.md, "What is still at risk"); the worker
  still re-checks, and nothing is applied without its own credential.

**T3. Replay.**

- Threat: a captured approval, chat request or apply job is sent again.
- Today: a chat request key is claimed once per connection, after the signature, case-folded (#359);
  the five-minute window refuses old and future timestamps; the writer looks for an existing pull
  request from `gaugeline/<draft id>` before it opens one, and the approval expires after 72 hours (#321).
- Planned: AG-06 receipts chain each approval to the one before, so a replayed or reordered row breaks
  the chain; AG-10 case "replayed approval".
- Test: `chat.test.ts` ("refuses the same signed request a second time (replay)"),
  `approval.test.ts` ("refuses an approval older than 72 hours").
- Residual: a replay inside the window of a request never seen before is a first request.

**T4. Double approve.**

- Threat: two presses, or two people, approve the same draft and two jobs run.
- Today: the unique index `decisions_one_choice_per_draft`; the second press is told who decided (#319,
  #359).
- Planned: AG-10 case "double-click approve".
- Test: `inbox.test.ts` ("approve: one decision row and one apply job, even on a double click"),
  `chat.test.ts` (double press, three at once).
- Residual: none known for the decision; the job queue (G36) must keep one job per decision.

**T5. Stale approval, or approval of an edited draft.**

- Threat: what a person approved is not what is applied (the draft changed after, the target moved, or
  the approval is old).
- Today: the database hashes the payload at the decision (the edited payload after "Edit first"); the
  writer refuses a job whose text or hash differs, a withdrawal, an expired or future approval (#321).
- Planned: AG-06 receipts cover the exact diff and the approver; AG-10 case "approval of an edited draft".
- Test: `approval.test.ts` ("refuses a payload that is not the one approved").
- Residual: the target can change between approval and apply in ways a pull request does not detect
  (the base branch moves); the person reviews the pull request before merging.

**T6. Cross-tenant read** (LLM08:2025 names multi-tenant "context leakage between users"; this record
applies it to rows, not vectors).

- Threat: an agent or person of one organisation reads another's sites, findings, drafts or secrets.
- Today: row-level security on every hosted table; the agent and chat roles read no table; secrets are
  readable only through definer functions, by the worker and, one connection at a time, the
  chat endpoint (`docs/hosted/secrets.md`).
- Today (AG-08): an agent reads hosted data only through `private.agent_list_pending` and
  `private.agent_list_runs`, with its own registry token (scopes `read:pending`, `read:runs`), read-only; the
  organisation comes from the token, never from the request (`docs/hosted/api.md`). Planned: AG-10 case
  "cross-tenant token".
- Test: `apps/hosted/db/__tests__/rls.test.ts` ("selecting org B's sites, runs, findings and drafts
  returns zero rows"), `chat.test.ts` ("another organisation's draft is not found, even for a person who
  belongs to both"), `secrets.test.ts`.
- Residual: the MCP server's in-memory runs are shared by every caller with the operator token
  (docs/mcp.md, "What it keeps"); it is one operator by design.

**T7. Runaway cost and flooding** (LLM10:2025, "Denial of Wallet").

- Threat: a looping agent fills the inbox, makes unbounded requests, or spends without limit.
- Today: no model is called anywhere, so there is no token spend. The MCP server caps a call at two
  minutes and 16 calls at once, and request bodies at 1 MiB; the agent entry caps 50 findings a draft and
  200 waiting drafts a site.
- Planned: AG-03 rate limit, cost ceiling and timeout per agent, checked before the call; AG-22 per-run,
  per-day and per-workspace ceilings with a pre-run estimate and a hard stop; AG-21 stops on budget;
  AG-10 cases "cost-cap breach", "oversized input".
- Test: `inbox.test.ts` ("a site holds at most 200 undecided agent drafts"); the cost ceilings: none yet.
- Residual: until AG-03, nothing limits how often a valid agent token calls.

**T8. Secret leakage** (LLM02:2025, "security credentials"; LLM07:2025, "sensitive data such as
credentials ... should not be contained within the system prompt").

- Threat: a key reaches a log, a trace, a finding, a prompt or a model provider.
- Today: agent and site tokens are stored as SHA-256 only; the agent token is a bind parameter; the
  writer never records the token, the payload or the response body; the hosted service holds no write
  credential (ADR-0010).
- Planned: AG-05 stores input and output hashes, never raw secrets, and redacts before storing; AG-20 no
  key stored by Gaugeline, never printed or logged; AG-23 redacts before any model call; AI-10 reports a
  key's provider and file, never the value.
- Test: `packages/writer/src/__tests__/apply.test.ts` ("never records the token or the payload in the
  trail"), `gmail-apply.test.ts`, `secrets.test.ts`.
- Residual: redaction is pattern-based; a secret in a shape no pattern knows passes it.

**T9. Tool-output poisoning** (LLM05:2025, "Treat the model as any other user, adopting a zero-trust
approach").

- Threat: what one tool or model returns (a malformed result, a third-party MCP server's answer, a
  model's draft text) is fed to the next step as if it were trusted.
- Today: a draft's shape is checked by the database and again by the writer, unknown keys are refused,
  and one-line fields refuse line breaks and bidirectional controls (#319, #321).
- Planned: AG-09 asserts schema valid, only existing finding ids cited, no invented numbers; AG-10 case
  "malformed tool output"; AG-21 escalates once on a schema failure, then stops. A third-party MCP
  server is read only as ADR-0008 proposes (an allowlist and a listing hash), which is not built.
- Test: `apps/hosted/db/__tests__/kinds.test.ts`, `packages/writer/src/__tests__/kinds-parity.test.ts`;
  the eval assertions: none yet.
- Residual: a well-formed draft can still say something wrong; the person reads it.

**T10. Shadow agents: unregistered or forgotten tokens.**

- Threat: a token nobody owns, or nobody has used in months, still works.
- Today: revoking a token stops the agent at once (`revoked_at`); there is no owner, name or last use.
- Planned: AG-02 registry (name, owner, scopes, hashed token, created, last used, status, revoke in one
  action, no privilege by default); a token with no owner or no recent use is flagged; AG-10 cases
  "expired token", "revoked agent".
- Test: `inbox.test.ts` ("refuses an unknown, revoked or short token"); the flag: none yet.
- Residual: an agent run entirely on someone's machine against the local MCP server is not in the
  registry; the registry is the inventory of hosted agents only.

**T11. A model-judged result gating a build** (LLM09:2025, "Cross-Verification and Human Oversight").

- Threat: a model's opinion passes or fails a launch, and is wrong.
- Today: no check calls a model; the same input gives the same findings (ADR-0002).
- Planned: a model result is advisory or `unsure`, never pass, never an exit code; AG-11's live-model
  evals are manual and never in CI.
- Test: `packages/core/src/__tests__/no-model-calls.test.ts`; "never gates": none yet (AG-09).
- Residual: a person may still over-trust a worded draft.

**T12. Excessive agency: a write tool appears** (LLM06:2025, "excessive functionality"; "Require user
approval").

- Threat: a tool that publishes, sends, merges or edits live is added, and an agent can call it.
- Today: the MCP registry has no such tool and a test fails if one appears; the writer registry is frozen
  and a scan fails the build if the writer can ask for a merge (ADR-0010); X72 stays parked.
- Planned: AG-03's allowlist cannot name a tool that is not in the registry; AG-09 asserts "no write call
  attempted".
- Test: `packages/mcp/src/__tests__/registry.test.ts`, `packages/mcp/src/__tests__/no-write.test.ts`,
  `scripts/__tests__/writer-no-merge.test.ts`.
- Residual: none known while the registries are the only way to call anything.

### 2. The decisions the rows build

1. **Registered agents only (AG-02).** No registry row, no call. A new agent has no privilege until a
   person grants scopes.
2. **Deny by default (AG-03).** A per-agent tool allowlist, rate limit, cost ceiling and timeout, checked
   in code before the call; a kill switch per agent and one global; every deny is traced with its reason.
3. **Trace every call, append-only, redacted (AG-05)**: agent, tool, input and output hashes, latency,
   tokens and cost, decision, approver.
4. **Hash-chained receipts verified offline (AG-06)**: `gaugeline receipts verify` checks the chain with
   no network. No WebAuthn.
5. **Evals and a red-team suite that fail closed (AG-09, AG-10)**, offline, in the normal test run, with
   recorded model output. A case that does not fail closed fails the build.
6. **Deterministic first.** A model only words a draft, behind AG-19's interface, with a recorded fake so
   tests need no key, network or secret. A model-judged result never gates and never says pass.
7. **No key stored by Gaugeline.** AG-20 modes 1 (the key in the user's environment, CLI) and 2 (the
   model call in the customer's worker). Mode 3 (a managed key in Vault, metered) is parked with billing.
8. **Page text is data, never an instruction (AG-01).**
9. **Drafts only, zero write tools.** Agents write drafts through the agent entry; only ADR-0010's writer
   writes, after a person's approval.

### 3. Out of scope

- Active security testing of checked sites, and any attack payload (rule 14).
- A compromised customer worker, machine or CI: it holds the customer's own credentials by design.
- The model provider's own security, retention and training use (AG-23 documents what is sent).
- A person who approves a harmful draft on purpose; the receipt shows who did.
- Agents a customer runs outside Gaugeline, with their own tools, against their own systems.
- WebAuthn or a second factor on approve (ADR-0010 lists it under "What would change it").
- Model theft, training-data poisoning and embeddings (LLM03, LLM04, LLM08 in OWASP's sense): Gaugeline
  trains nothing and keeps no vector store.

## Alternatives

- **A. No agents at all.** Keep the MCP server read-only and the inbox fed by people. Lost: the batch's
  owner rows ask for draft-only agents, and the controls in #319 and #321 already exist for them.
- **B. Trust the model's own refusal.** Rely on system prompts telling the model to ignore page text.
  Lost: OWASP's own entry says a system prompt "should not be considered a secret, nor should it be used
  as a security control", and an injected page is the input it is meant to resist.
- **C. One shared agent token per organisation (today's shape).** Lost: no owner, no scopes, no last use,
  so a forgotten token is invisible and one revoke stops every agent.
- **D. Allow-by-default with a block list.** Lost: a new tool is reachable until someone remembers to
  block it; deny by default makes forgetting safe.
- **E. A model as judge in CI.** Lost: it is not reproducible (ADR-0002), and a wrong pass ships a site.
- **F. Gaugeline holds model keys (mode 3) now.** Lost for now: a key store, metering and a breach that
  spends every customer's money; it waits for billing.
- **G. Mutable logs with access control instead of append-only traces and receipts.** Lost: an admin, or
  an attacker with the admin's session, could rewrite what happened.

## Cost

- Every agent call pays a registry lookup, a policy check and a trace write before it runs.
- A new agent needs a registry row, an allowlist, limits, an eval set and red-team cases before it ships.
- Append-only traces grow without bound; retention and pruning need their own decision (unbuilt).
- A model can only word drafts, so features that need a model's judgement to act are not offered.
- BYOK leaves the customer to set and guard a key; mode 3 convenience waits for billing.
- Pattern-based redaction misses secrets of unknown shapes (T8).

## What would change it

- A write tool requested for an agent, or X72 un-parked: a new record first.
- A row that needs a `POST` outside `packages/core/src/notify/post.ts` (for example AG-13 posting to
  Slack another way): an ADR changing ADR-0005 first. AG-13 through `notify/post.ts` needs none.
- AG-06 receipts that need a column on, or a change to, ADR-0010's `decisions` rows rather than a new
  table: an ADR changing ADR-0010 first.
- AG-20 mode 1 sends findings to a model provider from the CLI: that host must be a destination the user
  configured (ADR-0003), and `no-phone-home.test.ts` must name it.
- An injection that leads to an approved harmful draft in practice: require a second factor on approve.
- A red-team case found that passes open: stop that agent (its kill switch) until it fails closed.

## Needs from the owner

1. Accept or amend this record (number 0014, not 0011).
2. Decide whether `ownerConsent` on the MCP server should also require an operator flag naming the hosts
   (T2): today the model sets it.
3. Decide retention for AG-05 traces and AG-06 receipts.

## Enforced by

What holds today:

- `packages/core/src/untrusted.ts`, `packages/core/src/__tests__/untrusted.test.ts` and
  `packages/core/src/__tests__/untrusted-output.test.ts` (T1)
- `packages/mcp/src/__tests__/agent-text.test.ts`, `packages/mcp/src/__tests__/registry.test.ts` and
  `packages/mcp/src/__tests__/no-write.test.ts` (T1, T12)
- `apps/hosted/db/__tests__/inbox.test.ts`, `apps/hosted/db/__tests__/rls.test.ts`,
  `apps/hosted/db/__tests__/chat.test.ts`, `apps/hosted/db/__tests__/secrets.test.ts` and
  `apps/hosted/db/audit.ts` (T2 to T7, T10)
- `packages/writer/src/__tests__/approval.test.ts` and `packages/writer/src/__tests__/apply.test.ts`
  (T3, T5, T8)
- `scripts/__tests__/writer-no-merge.test.ts` (T12)
- `packages/core/src/__tests__/no-model-calls.test.ts` (T11)
- `packages/cli/src/__tests__/no-phone-home.test.ts` (no destination the user did not configure)

Planned, by row: AG-01 parts 2 and 3 (#374) the hostile-page walk; AG-02 registry tests; AG-03 policy
and deny tests; AG-05 trace redaction tests; AG-06 `gaugeline receipts verify` with a tampered chain;
AG-09 eval harness; AG-10 red-team suite (each case must fail closed); a scan, written with AG-19, that
fails any import of a provider SDK outside the model adapters.

## Sources

- **OWASP Top 10 for LLM Applications 2025**, read from OWASP's own repository at commit `99f4395`,
  https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/99f4395589bdbd120ae961f9cd179e79d7f9b27f/2_0_vulns/
  (genai.owasp.org did not resolve from this session, so the published page is unverified). [docs]
  - `LLM01_PromptInjection.md`, "LLM01:2025 Prompt Injection": "Indirect prompt injections occur when an
    LLM accepts input from external sources, such as websites or files"; mitigation 6: "Separate and
    clearly denote untrusted content to limit its influence on user prompts."
  - `LLM02_SensitiveInformationDisclosure.md`, "LLM02:2025": sensitive information "includes ...
    security credentials".
  - `LLM05_ImproperOutputHandling.md`, "LLM05:2025": "Treat the model as any other user, adopting a
    zero-trust approach".
  - `LLM06_ExcessiveAgency.md`, "LLM06:2025": root causes "excessive functionality; excessive
    permissions; excessive autonomy"; "Utilise human-in-the-loop control to require a human to approve
    high-impact actions before they are taken"; "Implement authorization in downstream systems rather
    than relying on an LLM to decide if an action is allowed or not."
  - `LLM07_SystemPromptLeakage.md`, "LLM07:2025": "the system prompt should not be considered a secret,
    nor should it be used as a security control."
  - `LLM08_VectorAndEmbeddingWeaknesses.md`, "LLM08:2025": "In multi-tenant environments ... there's a
    risk of context leakage between users or queries."
  - `LLM09_Misinformation.md`, "LLM09:2025": "Implement human oversight and fact-checking processes".
  - `LLM10_UnboundedConsumption.md`, "LLM10:2025": "Denial of Wallet (DoW)"; "Apply rate limiting and
    user quotas".
- **Repository:** PRs #243, #258 (N17), #319 (G37 inbox), #321 and #356 (writer), #359 (X69 part 1 and
  its credential review findings 1 and 2), #368 (AG-01 part 1); ADR-0002, 0003, 0005, 0008, 0010;
  docs/mcp.md, docs/hosted/inbox.md, writer.md, secrets.md, chat-approvals.md; batch AG rows. [repository]
- **uncited:** the threat list's grouping, the `ownerConsent` finding (read from the code), and every
  OWASP id mapping, which is this record's reading.
