# ADR-0005: Notifications post to your own channels

Status: accepted Date: 2026-11-06

## Context

ADR-0001 makes Gaugeline read-only by construction: every request goes through the fetcher, which
sends only `GET` and `HEAD`, and only `packages/core/src/transport.ts` may open a connection.
Sending results to Slack, Discord or a webhook (G14) needs a `POST`. Those requests never go to the
site being checked: they go to addresses the person gave Gaugeline (a flag or an environment
variable), at their request, to deliver their own results.

## Decision

`packages/core/src/notify/post.ts` is the one other module allowed to make a request, and the only
code in Gaugeline that sends a `POST`. It posts JSON to the configured channel addresses only, with
a 10 second timeout, and reports each address by its host alone. It is not the fetcher, so the
fetcher's read-only guard still covers every request to the checked site, unchanged.

## Amendment, 13 Nov 2026: model providers, modes 1 and 2

Accepted by the owner. This adds a second kind of `POST` to the one the record already allows. Like the
channel notifications, it never goes to the site being checked.

- **What it is.** A request to a model provider, made with the person's own key, to word a draft for them
  (batch AG, rows AG-19 to AG-25). The key comes from the person's own environment. Gaugeline stores no key
  and prints or logs none.
- **Mode 1:** the command line, in the person's own process, with the key in their environment.
  **Mode 2:** the hosted tier, where the call runs in the customer's own worker with the customer's own key.
  **Mode 3** (a managed key held by Gaugeline in a vault, with metering) is not accepted: it stays parked with
  billing.
- **One file.** A single module sends these requests, separate from `notify/post.ts` and from the fetcher;
  the lint rule and the post-boundary test name it, the way the writer's senders are named in ADR-0010.
- **A host allowlist.** The module can reach only the provider hosts on a list kept in that module, over
  https, with no redirects and no address the fetcher's rule would refuse. A provider is added by a change
  to the list and its test, never by a setting.
- **What may leave the machine.** Findings, evidence snippets and ids only, after secrets and personal data
  are redacted. Never a whole page, never a response body from the checked site, and never a key. The row
  that builds this (AG-23) documents what leaves the machine in each mode.
- **A model only words a draft.** A model-judged result never gates a build and never says pass (batch AG
  rules); every model call sits behind an interface with a recorded fake, so tests and CI need no key and no
  network.
- **Not accepted here.** The Action pull request comment (a `POST` to GitHub from the Action) was parked by this
  amendment; the amendment of 14 Nov 2026 below accepts it, on its own terms.

No code ships with this amendment. CLAUDE.md rule 6 is not edited; the proposed sentence waits for the
owner's approval. Enforced by, when AG-19 lands: `eslint.config.js` and
`packages/core/src/__tests__/post-boundary.test.ts` name the one module, and a contract test asserts the
host allowlist and that no other file imports `node:http`, `node:https` or calls `fetch` for a provider.

## Amendment, 14 Nov 2026: a summary comment on the pull request

Accepted by the owner on 14 November 2026 (the decision to build the Action pull request comment as one row: this
amendment first, one named sender, a summary of this run's findings and nothing else, an independent review, no
auto-merge). This adds a third kind of `POST` to the two the record and ADR-0006 already allow. Like the channel
notifications and the model call, it never goes to the site being checked.

- **What it is.** One `POST` per run to the GitHub REST API, `POST /repos/{owner}/{repo}/issues/{pull_number}/comments`
  ("Create an issue comment", which comments on a pull request too), on the person's own pull request, made by the
  Gaugeline GitHub Action with the workflow's own `GITHUB_TOKEN`. The comment is a summary of this run: counts by
  severity, a capped number of finding titles with their check ids, how many findings are new compared with the
  baseline from the main branch, and the run's exit state.
- **Off by default.** The Action sends nothing unless the person turns it on, and the job then needs
  `permissions: pull-requests: write`. A run that is not a `pull_request` event posts nothing. `pull_request_target`
  is never used or accepted: it runs with a write token in the base repository's context, which is the wrong place
  to run anything that reads a pull request from a fork.
- **One file.** A single module, `packages/core/src/pr-comment/send.ts`, sends it. It is separate from
  `notify/post.ts`, the model sender and the fetcher; `eslint.config.js` and
  `packages/core/src/__tests__/post-boundary.test.ts` name it, and `pr-comment/__tests__/send.test.ts` fails if a
  second file in that folder may open a connection or if this one grows a second verb. The named-sender list grows
  by exactly this entry. (`packages/writer/src/__tests__/guards.test.ts` is the writer's own boundary test: this
  sender is not in the writer, and that list is unchanged.)
- **A host allowlist of one.** `api.github.com`, over https on the default port, kept in that module. The module
  builds the address itself from a validated owner, repository name and pull request number, and refuses any
  other. It follows no redirect (a 3xx is a failure), refuses a name that resolves to an address the fetcher
  would refuse, at connect time, and uses its own https agent so Node's proxy support cannot skip that rule. GitHub
  Enterprise Server is out of scope: the sender never reads `GITHUB_API_URL`, and a different host is a change to
  this list and its test, never a setting.
- **`POST` only, so a new comment every run.** No `PATCH`, `PUT` or `DELETE`: Gaugeline cannot edit or remove a
  comment, its own included, so a pull request gets one comment per run. A later amendment could let it update
  its own previous comment; that needs one `PATCH` and a way to find the comment, and is not accepted here.
- **The token.** It is the workflow's `GITHUB_TOKEN`, read from the environment by the caller and handed to the
  sender per call. It goes into one `Authorization` header and is never kept, logged, put in a finding, a
  report, an error or the comment. Gaugeline asks for no other token and stores none.
- **What the comment may hold.** Counts by severity; up to 10 finding titles, each with its check id and a link
  to that check's page on gaugeline.dev; how many findings are new compared with the main branch's baseline, or the
  words "no baseline to compare with" when there is none; the exit state. Never a response body, a page's text, a
  key, an address, or a snippet from the checked site beyond the finding's title. Page-derived text is cut,
  sanitised and shown inside a code span, so it cannot mention a person, link to another host, open a tag or
  start markup. The whole comment is capped well under GitHub's limit of 65,536 characters. The same input gives
  the same comment; no model writes any of it (CLAUDE.md rule 7).
- **A pull request from a fork.** Its token is read-only, so GitHub answers 403. That is one plain line,
  "could not post the comment (read-only token)", and never fails the check or changes its exit code. The same
  goes for any other failure to post: one line, the check's result unchanged.
- **One attempt.** No retry: a failed `POST` is reported and the run carries on. GitHub documents that creating
  content too quickly may trigger secondary rate limits, so a run makes one request and waits for none.
- **Not accepted.** Updating or deleting a comment, a review comment, a check run or annotation, a commit status,
  a label, any other GitHub endpoint, and a `POST` to any host but `api.github.com`.

The sender ships first (this amendment, the module, the rule entries and the tests; nothing calls it yet); the
formatter, the flag and the Action input follow in their own pull request. CLAUDE.md rule 6 is not edited; the
proposed sentence waits for the owner's approval.

Sources: GitHub REST API, "Create an issue comment" (docs.github.com/rest/issues/comments#create-an-issue-comment;
its description says the endpoint "triggers notifications" and that "Creating content too quickly using this
endpoint may result in secondary rate limiting"; its operation takes the single field `body`). GitHub Actions,
"Automatic token authentication": for a pull request from a fork, "the permissions are adjusted to change any write
permissions to read only", and a workflow run by Dependabot is treated the same way. The app permissions table
lists the endpoint under both "issues" and "pull_requests" at "write". Rate limits: a 403 or 429 with
`x-ratelimit-remaining: 0` or a `retry-after` header is a rate limit.

## Alternatives

- **Teach the fetcher to POST.** Lost because the guard would need an exception at the point every
  site request passes through; one mistake there would let a check write to the site.
- **Leave notifications to the user's own scripts (pipe `--json` into curl).** Lost because the docs
  promise built-in channels, and a broken script is easier to get wrong than one tested sender.

## Cost

There are now two modules that open connections instead of one, and a reviewer has to know both.
A notification to a misconfigured address is a request to a host the checked page never named.

## What would change it

A `POST` anywhere outside `notify/post.ts`, or a send whose address did not come from the person's
own flags or environment.

## Enforced by

- `eslint.config.js` (`no-restricted-imports`: `node:http` and `node:https` only in
  `packages/core/src/transport.ts` and `packages/core/src/notify/post.ts`)
- `packages/core/src/notify/__tests__/notify.test.ts` (the fetcher still refuses `POST`; addresses
  appear as their host only)
- `eslint.config.js` and `packages/core/src/__tests__/post-boundary.test.ts` (the pull request comment sender,
  `packages/core/src/pr-comment/send.ts`, is named: `node:https` only there, one `POST`, for verb and network
  only)
- `packages/core/src/pr-comment/__tests__/send.test.ts` (one `POST` to `api.github.com` with the token in one
  header and a `{ body }` payload; no `PATCH`, `PUT` or `DELETE`, no `fetch`, no environment read; a target
  that is not a repository and a pull request number is refused before anything is sent; no redirect, no retry,
  no answer read; the token is in no result; a name that resolves to a private address is refused; a second
  file that sends fails the scan and the lint rule)
