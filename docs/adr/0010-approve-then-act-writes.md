# ADR-0010: Approve-then-act writes: a person approves one proposal, the customer's own worker writes one draft

Status: proposed Date: 2026-11-12

**Waiting for the owner's decision; nothing that writes is built.** This record proposes; it changes no
code, no flag and no line of CLAUDE.md. Rows X70 (a fix as a pull request), X71 (a draft in the content
system), X72 (one field on one record), X75 (a draft in the person's own mailbox) and the body of G37's
apply job are held until the owner accepts this record, changes it or refuses it. G37 builds the drafts
inbox, the decision log and the apply-job enqueue regardless: none of those writes to anything outside
Gaugeline's own database. Branch `08/adr-approve-then-act`. The hosted plan called this record
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

Three things in the spec contradict each other and need the owner:

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

**Proposed:** a third, narrow exception to rule 6. After a person approves one proposal in the signed-in
inbox, a job in the customer's own worker, with the customer's own write credential, creates **one draft**
in the customer's own system (a draft pull request, a content-system draft, a mailbox draft) or, if the
owner also accepts part 6, sets **one field on one record** and keeps the old value. Nothing else writes.

### 1. What is written, to what, with whose credentials

| Kind           | Requests the writer may send (registered, nothing else)                                                                      | Credential (customer's, in the worker's environment)                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `pull_request` | GitHub: create a blob, tree and commit, create one ref `gaugeline/<proposal id>`, create one pull request with `draft: true` | A fine-grained token for one repository: `contents` write, `pull_requests` write |
| `sanity_draft` | Sanity Actions API: `sanity.action.document.create` or `.edit` on a `drafts.` id only, `dryRun` first                        | A Sanity token with write access to one dataset (no draft-only role is verified) |
| `email`        | Gmail: `users.drafts.create`. Outlook: held (decision 3)                                                                     | Gmail OAuth with the one scope `gmail.drafts.create`                             |
| `record_field` | One `PATCH` (or the platform's documented single-field update) to one record id, with the platform's revision guard          | A token for that one system, separate from its read-only key                     |

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
- **Kill switches, any one stops every write:** an environment variable on the worker (the name is the
  release PR's choice), checked before each request, not once at start; an organisation-level "pause
  applying" in the hosted app, which makes job claims return nothing; and revoking the token, which the
  docs page names as the last resort. A paused job stays in the inbox, as X75 asks when a token is revoked.

### 6. X72 is the one write that is not a draft (decision 2)

X70, X71 and X75 each leave a person one more act: merge, publish, send. X72 does not: the approved field
is live when it is written. It is proposed under extra rules: one record and one field per proposal, a
proposal that would touch more is refused; never a delete; never a price in a payment system; never
content that publishes; the platform's revision guard on the request; the old value in the log; a re-check
at once. The owner may accept parts 1 to 5 and hold X72.

### 7. What is never written

- A live site's code: never the default branch or any branch but the one the writer created
  (`gaugeline/<proposal id>`); never a merge (the merge endpoint is not registered; a scan fails any file
  that names it), never a force push, never a workflow file under `.github/` (proposed: uncited).
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
kind's shape again before sending. N17 is not built yet; this part cannot ship before it.

### 9. Rule 6 after acceptance (the release PR edits CLAUDE.md; this PR does not)

Proposed sentence, to follow the ADR-0006 sentence in rule 6:

> That makes three: the owner decided (ADR-0010) that after a person approves one proposal in the
> signed-in inbox, or runs `gaugeline apply <proposal> --approve` for it, a job in the customer's own
> worker, with the customer's own write credential, may create one draft (a draft pull request on a new
> branch, a content-system draft, a mailbox draft) or set one approved field on one record keeping its
> old value, through the registered writer only; it never merges, publishes, sends or deletes, never
> writes without an approval row, and the checker and the hosted service never write.

The same release PR must also: replace "Reading only: nothing in this branch writes to any system it
checks" in X70, X71, X72 and X75 with "Writes only as ADR-0010 allows"; update "What it can and can't
write" (its first line, and a new "Drafts it writes after you approve" section with the table in part 1);
and add the writer files to the post-boundary scan's list of files allowed to send, by name, with ADR-0010
cited beside them. Adding them before the owner accepts this record would be loosening a safeguard to make
CI pass (rule 13).

### Decisions for the owner

1. **Accept a third exception to rule 6** for drafts (X70, X71, X75 and G37's apply body), as parts 1 to
   5, 7 and 8 say, or refuse it (option A or B below), or choose another.
2. **X72:** accept it under part 6's rules, or hold it (a direct, live write is a different promise from a
   draft).
3. **Outlook:** accept `Mail.ReadWrite` (it can read and delete mail; X75's rule says no read permission is
   ever requested), or ship Gmail only and hold Outlook.
4. **GitHub merge risk:** the token that opens a pull request can merge it. Accept that Gaugeline's code
   never calls merge and the docs tell the customer to protect the default branch, or require the writer to
   refuse a repository whose default branch it cannot confirm is protected (that confirmation needs a read
   the token may not be allowed: uncited).
5. **The rule 6 sentence** in part 9, as written or changed.
6. **Packaging:** the writer as a separate package the CLI does not install by default (proposed), or
   inside the CLI behind the configuration switch.

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
  preview. No new exception; this is the fallback if the owner refuses.
- **C. Write only to the user's own channels.** Extend ADR-0005: post the proposal (diff, value, email
  text) to the person's Slack, email or a GitHub issue. Cost: the same hand work as B, plus one more
  message; it fits the existing exception, but it is notification, not a fix.
- **D. Drafts after an approval, in the customer's worker (recommended).** This record. Cost: a third
  exception, a writer package to review, write tokens that customers must create and guard, a token on
  GitHub that could merge and one on Outlook that could read. Why it wins: every write leaves a person one
  more act (merge, publish, send), except X72, which is held apart; the approval is recorded where nobody
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
- The customer creates and guards one more token per platform. On GitHub that token can merge; on Outlook
  (if accepted) it can read and delete mail. Gaugeline's code limits what it does with them; it cannot
  limit what the token allows.
- A forged approval in the hosted database would enqueue a write. The payload hash, the expiry, the
  worker's own checks and the dry-run default narrow that; they do not remove it.
- Sanity: whether a token can be limited to drafts depends on the customer's plan and roles, which were not
  verified (uncited). Without it, the code is the only thing that keeps a publish out.
- X70, X71, X72 and X75 wait for this decision and for N17.

## What would change it

- A write found anywhere but the registered writer, or a write with no approval row: stop applying and
  reopen this record.
- A vendor offering a narrower credential (a GitHub permission to open but not merge; a Graph permission to
  create drafts only): adopt it and drop the matching risk from Cost.
- Customers who never turn writing on (dry-run rows and no `applied` rows over a release cycle): consider
  option B and remove the writer.
- An approval forged or replayed in practice: require a second factor on approve.

## Enforced by

Nothing new, because nothing is built. What already holds, and what a writer would have to pass:

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
- **Spec G34, G37, N17, X69, X70, X71, X72, X75; hosted plan (owner decision 1); docs/writes.md;
  docs/mcp.md; ADR-0001, 0005, 0006; CLAUDE.md rules 6, 7, 11, 13, 14.** [repository]
- **uncited:** the 72-hour expiry, the branch prefix, refusing `.github/` workflow files, the kill-switch
  design, the payload hash, and the decision row fields beyond G34's, which are this record's proposals.
