# ADR-0010: Approve-then-act writes: a person approves one proposal, the customer's own worker writes one draft

Status: accepted Date: 2026-11-12

**Accepted by the owner on 12 November 2026, with the six decisions below.** Writes are allowed for
drafts only: a pull request, a content-system draft and a Gmail draft, each applied by G37's apply job
after a recorded human approval. X72 (a live one-field write) and Outlook are held to v1.1. Nothing that
writes is built by this PR, and CLAUDE.md is unchanged until the release PR (part 9). Branch `08/adr-approve-then-act`. The hosted plan called this record
"ADR-0009"; 0009 is rendered checks, so it is 0010.

## Context

CLAUDE.md rule 6 says Gaugeline is read-only. It has two exceptions today, each in its own record and
each enforced by a test:

- **ADR-0005:** notifications to the person's own channels are `POST`s, from one file.
- **ADR-0006:** an adapter may `POST` a documented read-only query to an endpoint on its registered
  allowlist, through `fetcher.query` only. "`PUT`, `PATCH`, `DELETE` and any other method, to any host,
  from any file" stays forbidden, and so does "a `POST` that is not a query: a form, a login, a GraphQL
  `mutation` or `subscription`, a write or a create".

Five rows in the spec need a third exception, because each one changes something in a system the person
owns after a person says yes:

| Row       | What it writes                                                                           | To what system                               | What a person still does                                        |
| --------- | ---------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| X70       | A branch, one commit with the fixer's diff, a pull request with the finding and evidence | The customer's code repository (GitHub)      | Reviews and merges; Gaugeline "never merges"                    |
| X71       | A draft of one document with one field corrected, and a note naming the finding          | The customer's content system (Sanity first) | Reads and publishes; "a publish call doesn't exist in the code" |
| X72       | One named field on one identified record; the old value kept in the decision log         | A record in a system the site reads from     | Nothing: the approval is the change                             |
| X75       | One email draft addressed to the client, citing the findings                             | The person's own Gmail or Outlook mailbox    | Edits and presses Send; "Gaugeline never sends"                 |
| G37 apply | Whichever of the four the approved draft is                                              | As above                                     | As above                                                        |

The spec already says how these must be done, in pieces. G37: agents write rows into `drafts`; a person
approves, edits first or declines in the inbox; each choice inserts a row in `decisions`; "Approval
enqueues an 'apply' job that runs in the customer's worker with the customer's credentials, not in the
checker"; "the hosted service never holds write credentials"; the agent's database role "can insert into
drafts and nothing else". G34: `decisions` is append-only (INSERT and SELECT only, and a trigger that
raises on UPDATE or DELETE for every role). N17: page text is data; "No tool can trigger an action.
Anything that changes something ... needs a human approval recorded in the signed-in UI; a message,
finding or tool result can never approve." The docs page "What it can and can't write" already promises:
"An agent can draft a mutation, a person approves it, and then your worker applies it with your
credentials", while its first line says Gaugeline "never writes the C, U or D".

Three things in the spec contradicted each other; the owner's decisions settle each one:

1. Every one of X70, X71, X72 and X75 carries the house rule "Reading only: nothing in this branch writes
   to any system it checks", and each one's job is to write. Rule 6 as written forbids all four.
2. X75 says "Connect a mailbox with permission to create drafts only: not to read mail and not to send."
   Gmail has such a scope; Outlook does not (see Sources). Microsoft Graph's least privileged permission to
   create a draft is `Mail.ReadWrite`, which "Allows the app to create, read, update, and delete email in
   user mailboxes".
3. X70 says the pull request is never merged. A GitHub token that can open a pull request needs `contents`
   write to create the branch, and `contents` write is also the permission that merges one. The token
   cannot be narrowed to "open but not merge"; only the code and the repository's own branch protection can.

The MCP server's fix tool (`plan_fix` in docs/mcp.md; the task called it `draft_fix`) already stands on the
other side of this line: it "Prepares a fix and returns a link for a person to approve", and "Assistants can
plan a fix but never approve their own". That tool writes nothing; this record is about what happens after
the approval.

## Decision

A third, narrow exception to rule 6, for drafts only. After a person approves one proposal in the
signed-in inbox, a job in the customer's own worker, with the customer's own write credential, creates
**one draft** in the customer's own system: a draft pull request, a content-system draft, or a Gmail
draft. Nothing else writes. A live write of one field on one record (part 6) is held to v1.1.

### 1. What is written, to what, with whose credentials

| Kind           | Requests the writer may send (registered, nothing else)                                                                      | Credential (customer's, in the worker's environment)                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `pull_request` | GitHub: create a blob, tree and commit, create one ref `gaugeline/<proposal id>`, create one pull request with `draft: true` | A fine-grained token for one repository: `contents` write, `pull_requests` write |
| `sanity_draft` | Sanity Actions API: `sanity.action.document.create` or `.edit` on a `drafts.` id only, `dryRun` first                        | A Sanity token with write access to one dataset (no draft-only role is verified) |
| `email`        | Gmail: `users.drafts.create`. Outlook: held to v1.1                                                                          | Gmail OAuth with the one scope `gmail.drafts.create`                             |
| `record_field` | Held to v1.1. Then: one `PATCH` (or documented single-field update) to one record id, with the revision guard                | A token for that one system, separate from its read-only key                     |

- **One commit per file in v1 (flagged for the owner, PR #271).** The table says "create a blob, tree and
  commit". The first writer (`packages/writer`) commits each file with the Contents API instead
  (`PUT /repos/{owner}/{repo}/contents/{path}` on the draft's own branch), so a draft of three files makes
  three commits on `gaugeline/<proposal id>`. It needs the same permission (`contents` write), adds no
  endpoint outside the registry, and the pull request still shows one diff. A single commit through the
  Git Data API (blob, tree, commit, then move the ref) would add four registered requests and a ref update
  (a `PATCH`, which part 7 and the scans currently forbid), so it is left to the owner to ask for later.
- **A create-only mutation for Sanity (flagged for the owner, X71).** The table says "Sanity Actions API:
  `sanity.action.document.create` or `.edit` on a `drafts.` id only, `dryRun` first". The writer (`packages/writer`)
  uses the Mutations API instead: one `POST /v<version>/data/mutate/<dataset>` whose only registered mutation is
  `create` of a `drafts.<id>` document (a copy of the live document with the fix in it), after two `GET`s of
  `/data/doc/<dataset>/<id>` (the live document and its draft). Sanity refuses a `create` whose id exists (409),
  so an editor's own draft is never overwritten, which `.edit` on an existing draft would do. It needs the same
  token permission (create documents in one dataset), adds no endpoint outside the registry, and has no
  request for a patch, replace, removal, query selector or action, so there is no `publish` to refuse. The API
  version is pinned in the registry (`v2025-02-06`, the one the request shapes were read for), not a setting.
- **Separate keys.** Every write credential is a separate environment variable from the read-only key the
  same platform's adapter uses, and is optional. A run of `gaugeline` (the checker) never reads it: the
  checker and the writer are different processes and different packages, so the thing that observes and
  the thing that changes are never the same process (G37).
- **The hosted service never holds a write credential.** It holds drafts, decisions and jobs. The worker,
  on the customer's machine or CI, claims an apply job, reads its own environment, writes, and reports the
  outcome back as a decision row. A breach of the hosted service gives an attacker approvals to forge, not
  keys to use, and the worker re-checks every approval (part 3).
- **Locally**, `gaugeline apply <proposal> --approve` (X70, X71) is the same writer run by the person at
  their own terminal; typing the command for one proposal is the approval, and it is logged to the same
  decision format in a local file. There is no "approve all" (X70).

### 2. Only after which approval

A write needs a `decisions` row that says, all at once:

- **who:** a signed-in member with the `owner`, `admin` or `member` role (never `client`, never the
  `agent` database role, which cannot insert into `decisions` at all: G37's test);
- **what:** the draft id and the SHA-256 of the exact payload the person saw (after "Edit first", the
  edited payload; the original is kept, G37);
- **when:** the time, and an expiry (proposed: 72 hours; uncited);
- **how:** the inbox, or a verified chat click (X69: signature and timestamp checked, mapped to a member
  allowed to decide; "the same row" as the inbox would write).

Never an approval: a reply to an email (X75: "too easy to forge"), a finding, a tool result, a page, an
MCP call, a model's output, or a second click (a unique constraint on the draft id makes a double approval
one row and one job, G37).

### 3. What the worker checks before it writes

In this order, and it stops at the first that fails, appending a decision row that says why:

1. The kill switches (part 5) are off.
2. The approval row exists, is not expired, is not followed by a decline or a withdrawal, and its payload
   hash equals the hash of the payload in the job. A job without an approval row is refused, whoever
   enqueued it.
3. The payload matches the writer's registered shape for its kind (one file, one field, one document, one
   recipient list taken from the site's configured contacts, never from page text).
4. The target is still what the proposal saw: the record's revision or the field's old value (X72 "The
   record changed between proposal and approval: the proposal is withdrawn"); the open pull request for the
   same proposal (X70: found, not opened twice); an existing Sanity draft for that document (X71: the
   proposal says so and does not overwrite it).
5. Dry run, unless the worker's configuration says `write` for this kind (part 5).

### 4. The decision log

`decisions` (G34) is the record of every step: approved, edited and approved, declined, then one outcome
row appended by the worker: `dry_run`, `applied` (with the external id: pull request URL, draft id, record
id), `apply_failed` (the API's status, never its body), `withdrawn` (the target changed), and, for X72, the
old value and the new value. The re-check result is appended when the original check runs again (X70 on
the pull request's preview; X71 after an editor publishes; X72 at once). A re-check that still fails
reopens the finding (X72). The current state of a draft is a query over this log; nothing in it is
updated or deleted.

The old value is stored as the value, so a person can put it back by hand. Gaugeline does not offer an
"undo" that writes it back: that would be a second write without a second approval.

### 5. Off by default, a dry run first, and a kill switch

- **Off:** the writer package is not installed by `npx gaugeline`; the worker loads it only when its
  configuration names `apply`. Each kind is enabled separately, per site.
- **Dry run by default:** an enabled kind runs as a dry run until the configuration says `write` for it.
  A dry run builds the exact request, validates it against the registry, sends the provider's own dry run
  where one exists (Sanity Actions take `dryRun: true`), and appends a `dry_run` row with what would have
  been sent (field names and the new value; never a key).
- **A Sanity dry run is local (flagged for the owner, X71).** The bullet above says a dry run sends the
  provider's own dry run where one exists. The Sanity writer's dry run sends nothing at all, not a read and not
  a `dryRun=true` mutation: it checks the approval, the payload, the field fence and the registry, and records
  the three requests it would make. So it cannot detect a stale field (that needs the read); the write mode
  does, just before it writes. This keeps "a dry run sends nothing" true for every kind.
- **Kill switches, any one stops every write:** an environment variable on the worker (the name is the
  release PR's choice), checked before each request, not once at start; an organisation-level "pause
  applying" in the hosted app, which makes job claims return nothing; and revoking the token, which the
  docs page names as the last resort. A paused job stays in the inbox, as X75 asks when a token is revoked.

### 6. X72 is the one write that is not a draft: held to v1.1

X70, X71 and X75 each leave a person one more act: merge, publish, send. X72 does not: the approved field
is live when it is written. When it is built (v1.1), it is under extra rules: one record and one field per proposal, a
proposal that would touch more is refused; never a delete; never a price in a payment system; never
content that publishes; the platform's revision guard on the request; the old value in the log; a re-check
at once. It is not built in v1.

### 7. What is never written

- A live site's code. On GitHub the apply job does two things only: it pushes one new branch
  (`gaugeline/<proposal id>`) and opens a pull request from it. It never merges, never turns on
  auto-merge, never pushes to the default branch or any branch it did not create, never force-pushes, and
  never writes a workflow file under `.github/`. A scan fails the build if any file in the writer package
  can ask for a merge (Enforced by).
- **Customers protect their default branch.** A GitHub token that can open a pull request can also merge
  it, because both need `contents` write (Sources); only the repository's own rules stop that. The docs
  tell every customer to protect the default branch with required reviews and required status checks
  before giving the writer a token, so a merge needs a person even if the token were misused.
- A publish (no `sanity.action.document.publish` or `unpublish`; no id without the `drafts.` prefix), a
  send (no `drafts.send`, no `messages.send`, no `sendMail`), a delete of anything.
- Anything without an approval row; anything an agent, a model or a tool decided (N17); anything from the
  checker process or the hosted service.
- Anything to the checked site's own address. Rule 6's sentence on requests to a checked site does not
  change: they stay `GET` or `HEAD`, through the fetcher.

### 8. Page text never reaches a write unescaped (N17)

Fixers are plain rules (rule 7): a proposed value comes from a declared fact (the person's configuration:
the hours, the phone number, the redirect target) or from the platform's own structured data, never from
page text. Page text may appear in a proposal only as quoted evidence, as N17's `UntrustedText`, sanitised
and escaped for where it lands: Markdown in a pull request body, plain text in an email draft, a string
field in a Sanity note. It never becomes a branch name, a file path, a commit message's first line, a
recipient, a subject header, a field name or a record id. An agent may write a draft's prose (G37); the
person approves exactly the text the inbox showed them (the payload hash), and the writer validates the
kind's shape again before sending. N17 has merged (`packages/core/src/untrusted.ts`); the writer uses it.

### 9. Rule 6 after acceptance (the release PR edits CLAUDE.md; this PR does not)

The sentence the owner accepted, to follow the ADR-0006 sentence in rule 6:

> That makes three: the owner decided (ADR-0010) that after a person approves one proposal in the
> signed-in inbox, or runs `gaugeline apply <proposal> --approve` for it, a job in the customer's own
> worker, with the customer's own write credential, may create one draft (a draft pull request on a new
> branch, a content-system draft, a mailbox draft), through the registered writer only; it never merges,
> publishes, sends or deletes, never writes without an approval row, and the checker and the hosted
> service never write.

The same release PR must also: replace "Reading only: nothing in this branch writes to any system it
checks" in X70, X71, X72 and X75 with "Writes only as ADR-0010 allows"; update "What it can and can't
write" (its first line, and a new "Drafts it writes after you approve" section with the table in part 1);
and add the writer files to the post-boundary scan's list of files allowed to send, by name, with ADR-0010
cited beside them, in the writer's own branch and not before (rule 13).

## Owner decisions (12 Nov 2026)

1. **A third exception to rule 6, for drafts only:** pull requests, content-system drafts, mailbox drafts
   and G37's apply job, each applied only after a recorded human approval, in the customer's own worker,
   with the customer's own credentials.
2. **X72 (a live one-field write) is held to v1.1.**
3. **Mailbox drafts: Gmail only in v1**, with the draft-only scope `gmail.drafts.create`. Outlook (whose
   least privileged permission, `Mail.ReadWrite`, can read and delete mail) is held to v1.1.
4. **GitHub: the apply job only pushes a branch and opens a pull request, and never merges** (part 7). A
   test fails if the writer package can call any merge or auto-merge endpoint, and the docs tell customers
   to protect their default branch with required reviews and status checks.
5. **The rule 6 sentence** in part 9 goes into CLAUDE.md in the release PR, as written there.
6. **The writer is its own package, packages/writer**, which the checker and the main CLI do not depend on,
   so the CLI stays read-only and its size budget is untouched.

**Consequences.** Unblocked: G37's apply job body, X70 (pull request), X71 (content-system draft) and X75
for Gmail. Deferred to v1.1: X72 and Outlook. G37's inbox, decision log and apply enqueue were never
blocked.

## Owner acknowledgements (13 Nov 2026)

The owner acknowledged the three amendments that the writer pull requests flagged. Each narrows what the
writer can do compared with the first text of this record:

1. **One commit per file in v1** (flagged in part 1, #271): the writer uses the contents API, so a three-file
   draft is three commits and no ref is ever updated.
2. **A create-only mutation for Sanity** (flagged in part 1, X71): the registered request is the Mutations
   API `create` of a `drafts.` id, not the Actions API; a document that already exists answers 409 and is
   never overwritten.
3. **A Sanity dry run is local** (flagged in part 5, X71): a dry run sends nothing to the provider.

X72 (a live one-field write, decision 2) and Outlook drafts (decision 3) stay held. No CLAUDE.md sentence
for this record is written yet; the proposed wording waits for the owner's approval.

## Alternatives

- **A. Never write (the rule as it stands).** Proposals stay text: the inbox and the MCP server's fix tool
  show the diff, the field and the value, and a person makes the change by hand. Cost: X70, X71, X72 and
  X75 are not built as the spec describes; G37's apply job has nothing to run; the landing page's "acts
  when you approve" and the writes page's "your worker applies it" must be withdrawn. It keeps the
  promise simplest: Gaugeline never changes anything.
- **B. Proposals as text patches only (what the MCP fix tool does today).** `gaugeline propose` writes a
  patch file and prints each diff (X70 step 3 already allows this, as local files, like `--page`); the
  person runs `git apply`, pastes into Studio, or copies the email. Cost: friction at the moment the
  person is most likely to put it off; no external id, so the re-check cannot follow a pull request's
  preview. No new exception.
- **C. Write only to the user's own channels.** Extend ADR-0005: post the proposal (diff, value, email
  text) to the person's Slack, email or a GitHub issue. Cost: the same hand work as B, plus one more
  message; it fits the existing exception, but it is notification, not a fix.
- **D. Drafts after an approval, in the customer's worker (chosen).** This record. Cost: a third
  exception, a writer package to review, write tokens that customers must create and guard, a token on
  GitHub that could merge (so branch protection is required). Why it wins: every write leaves a person one
  more act (merge, publish, send), and X72, which would not, is held to v1.1; the approval is recorded where nobody
  can rewrite it; and the hosted service is never the thing holding the keys.
- **E. The hosted service applies with stored credentials.** Lost because the hosted service would hold
  every customer's write keys, so one breach writes to all of them; G37 rules it out.
- **F. Full agent writes (an agent applies, or "approve all").** Lost because a page can carry
  instructions (N17), and an agent that acts on what it read is the attack; X70 forbids "approve all"; and
  rule 7's "the same input gives the same findings" has no counterpart for an agent's edit.

## Cost

- Rule 6 gains a third exception, and its sentence gets longer; a reviewer has to know three boundaries.
- A writer package, its registry, and a scan entry to review for every new kind, and each platform's
  write endpoint to re-read when the vendor changes it.
- The customer creates and guards one more token per platform. On GitHub that token can merge, so the
  customer must protect the default branch. Gaugeline's code limits what it does with the token; it cannot
  limit what the token allows. Outlook waits for v1.1 for the same reason.
- A forged approval in the hosted database would enqueue a write. The payload hash, the expiry, the
  worker's own checks and the dry-run default narrow that; they do not remove it.
- Sanity: whether a token can be limited to drafts depends on the customer's plan and roles, which were not
  verified (uncited). Without it, the code is the only thing that keeps a publish out.
- X72 and Outlook wait for v1.1; a customer who needs either does it by hand until then.

## What would change it

- A write found anywhere but the registered writer, or a write with no approval row: stop applying and
  reopen this record.
- A vendor offering a narrower credential (a GitHub permission to open but not merge; a Graph permission to
  create drafts only): adopt it and drop the matching risk from Cost.
- Customers who never turn writing on (dry-run rows and no `applied` rows over a release cycle): consider
  option B and remove the writer.
- An approval forged or replayed in practice: require a second factor on approve.

## Enforced by

- `scripts/__tests__/writer-no-merge.test.ts` and `scripts/lib/writer-scan.ts` (owner decision 4: any
  file in the writer package that names a merge, an auto-merge, a merge endpoint or a merge mutation, even
  split into pieces or escaped, fails the build; a self-test runs each way of asking)

What already holds, and what the writer has to pass when it is built:

- `packages/core/src/__tests__/post-boundary.test.ts` and `packages/core/src/__tests__/post-scan.ts` (no
  file but the fetcher, the notifier, the transport and the app page builds a `POST`, `PUT`, `PATCH` or
  `DELETE`; the writer files would join that list by name, citing this record, in the release PR)
- `packages/core/src/fetch/query-registry.ts` (the model for a write registry: entries checked, frozen and
  looked up by id; the caller cannot write its own)
- `packages/core/src/notify/post.ts` and `eslint.config.js` (connections stay in named files)
- `packages/cli/src/__tests__/no-phone-home.test.ts` (a check run contacts only the checked site and
  configured destinations; a check run must never load the writer)
- `docs/writes.md` (the promise the release PR rewrites)

Tests the first writer branch must write first: a job with no approval row, an expired one, a declined one
and one whose payload hash differs are each refused with a decision row and no request; a double approval
yields one job; the dry run sends nothing but the provider's dry run; each kill switch stops a write
between two requests; the registry refuses the merge, publish and send endpoints and any id outside the
writer's own branch or `drafts.` prefix; a proposal touching two fields is refused; the token never
appears in a log, a decision row or a report; the hostile fixture's page text never appears in a branch
name, path, recipient or subject; and a scan that fails any file in `packages/core` that imports the
writer.

## Sources

Vendor documentation sites (docs.github.com, www.sanity.io, developers.google.com, learn.microsoft.com)
answered 403 from this session. Each [docs] line is read from the vendor's own published source on
raw.githubusercontent.com, on 2026-11-12.

- **GitHub REST API description** (`github/rest-api-description`, the source of
  https://docs.github.com/en/rest/pulls/pulls): `POST /repos/{owner}/{repo}/pulls` "Create a pull
  request" takes `draft` ("Indicates whether the pull request is a draft"); "you must have write access to
  the head or the source branch". `PUT .../pulls/{pull_number}/merge` "Merges a pull request". [docs]
- **GitHub fine-grained token permissions** (`github/docs`, the data behind
  https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens):
  create a pull request needs `pull_requests` write; create a reference needs `contents` write; merge a
  pull request needs `contents` write. [docs]
- **Gmail API discovery document** (Google's published `gmail/v1` discovery file, the source of
  https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create):
  `gmail.drafts.create` "Compose new draft emails"; `drafts.create` accepts it; `drafts.send` does not
  (its scopes are `mail.google.com`, `gmail.compose`, `gmail.modify` and an add-on scope). [docs]
- **Microsoft Graph, "Create message"** (`microsoftgraph/microsoft-graph-docs-contrib`, the source of
  https://learn.microsoft.com/en-us/graph/api/user-post-messages): "Create a draft of a new message";
  least privileged permission `Mail.ReadWrite`. Permissions reference: `Mail.ReadWrite` "Allows the app to
  create, read, update, and delete email in user mailboxes. Does not include permission to send mail." [docs]
- **Sanity client README** (`sanity-io/client`, which wraps https://www.sanity.io/docs/http-actions):
  "To create a draft document, prefix the document ID with `drafts.`"; Actions `sanity.action.document.create`,
  `.edit`, `.publish`, `.unpublish`, `.delete`; `dryRun` "no documents will be affected";
  `ifRevisionId` applies a patch only if the stored document matches. [docs] Token roles and whether a
  token can be limited to drafts: uncited (sanity.io unreachable).
- **Spec G34, G37, N17, X69, X70, X71, X72, X75; hosted plan (owner decision 1); the owner's decisions of 12 Nov 2026; docs/writes.md;
  docs/mcp.md; ADR-0001, 0005, 0006; CLAUDE.md rules 6, 7, 11, 13, 14.** [repository]
- **uncited:** the 72-hour expiry, the branch prefix, refusing `.github/` workflow files, the kill-switch
  design, the payload hash, and the decision row fields beyond G34's, which are this record's proposals.
