# Hosted: applying an approved fix

When someone approves a draft in [the inbox](./inbox.md), the hosted service does not change anything.
It queues an apply job. **Your own worker**, on your machine or in your CI, claims the job and runs the
writer (`packages/writer`) with **your own GitHub token**. The hosted service never holds a token that
can write ([What it can and can't write](../writes.md#fixes-you-approve-hosted), ADR-0010).

This page covers the `pull_request` kind, the `email` kind (a Gmail draft, near the end) and [the Sanity
draft kind](#sanity-drafts). Nothing changes a live field.

## An example: the bar's broken menu link

Northgate Studio approved the draft that points The Tidewater Bar's menu link at `/drinks`. Their worker
runs the writer as a dry run first, which is the default. A dry run sends nothing and records the
requests it would make. This is the real output of `applyPullRequest` in dry-run mode for that job:

```json
{
  "draftId": "a1d10000-0000-4000-8000-0000000000a1",
  "decisionId": "42",
  "outcome": "dry_run",
  "planned": [
    {
      "endpoint": "createRef",
      "path": "/repos/northgate-studio/tidewater-bar/git/refs"
    },
    {
      "endpoint": "putContent",
      "path": "/repos/northgate-studio/tidewater-bar/contents/app/menu/links.ts"
    },
    {
      "endpoint": "createPull",
      "path": "/repos/northgate-studio/tidewater-bar/pulls"
    }
  ]
}
```

With `mode: "write"`, the same job makes these requests, in this order, and records the pull request's
address:

1. Read the base branch's commit (`GET .../git/ref/heads/main`).
2. Look for a pull request, open or since closed, from `gaugeline/<draft id>`
   (`GET .../pulls?head=<owner>:gaugeline/<draft id>&state=all`). If there is one, record it and stop, so
   the same draft never opens two, even when it is replayed after you closed the pull request and deleted
   the branch.
3. Create the branch `gaugeline/<draft id>` (`POST .../git/refs`).
4. For each file, read its current version on the base branch, then commit the new content to the new
   branch (`PUT .../contents/<path>` with `branch` set; without it GitHub would write to the default
   branch, so the writer refuses a request that has no branch). **Each file is its own commit**: the
   writer uses GitHub's Contents API, so a draft with three files makes three commits on the branch (the
   pull request still shows one diff). ADR-0010 describes one commit built from a blob and a tree; v1
   takes the smaller route, which needs no extra permission, and the owner can ask for the single commit
   later.
5. Open the pull request as a draft (`POST .../pulls` with `draft: true`).

## What the writer checks before it writes

The job in the queue is only a claim: "this decision approved this payload". The writer does not take it
on trust. It reads the approval row itself, through an `Approvals.find(decisionId)` that **your worker**
implements over its own database connection, and checks these, in this order. The first one that fails
ends the job with a `refused` entry in the trail, and nothing is sent.

1. The job names a pull request draft by a UUID, and your configured target is plain names (an owner, a
   repository, a base branch name (not a full ref such as `refs/heads/main`, and no `..`), and the
   organisation and site ids).
2. No stop: `GAUGELINE_WRITER_STOP` is unset or `0`, and the organisation has not paused applying. If the
   pause cannot be read (the database is down), that counts as paused.
3. **The approval row exists** and is an approval (`approved`, or `edited` after Edit first). A job
   without one is refused, whoever queued it. A lookup that throws is a refusal too.
4. **It is this job's.** The row is for this decision and draft, this organisation, **this site** (the job
   carries the draft's `siteId`, and the writer refuses a job for any site but the configured target's)
   and this kind.
5. **The hash matches.** The SHA-256 of the job's payload text equals the approval's hash, and so does the
   hash the job carries. The comparison is constant-time and accepts only lower-case hex.
6. **It was not withdrawn.** The only decisions that may follow an approval are the writer's own outcomes
   (`dry_run`, `apply_failed`, `refused`, `applied`). Any other word, including `declined`, `withdrawn`,
   `Withdrawn` or one this version does not know, counts as a withdrawal.
7. **It has not expired, and was not decided in the future.** The approval is less than 72 hours old. A
   shorter expiry on your record is honoured; a longer one is not. A `decidedAt` more than five minutes
   ahead of the worker's clock is refused (`approval`).
8. The payload matches the fixed shape for its kind (the inbox's shape checks, plus the longer list of paths below; a test holds that the writer accepts nothing the inbox refuses), and every file is
   inside your `allowedPrefixes` if you set them.
9. Every request of the plan passes the registry, in a dry run too (the dry run uses a placeholder for the
   base commit, which the real run reads first).

Then, before **each** request, the stop switches again.

An approval row looks like this to the writer (your worker fills it from the decisions log):

```ts
interface Approval {
  decisionId: string;
  draftId: string;
  orgId: string;
  siteId: string; // the draft's site
  kind: string; // "pull_request"
  decision: string; // "approved" | "edited"
  payloadSha256: string; // computed by the database
  decidedAt: Date;
  expiresAt?: Date; // optional: earlier than decidedAt + 72 h
  later: readonly string[]; // decisions recorded after this one, e.g. ["dry_run"]
}
```

## What the writer refuses

- **Anything not on its list.** The writer knows six GitHub requests: the three reads above and the three
  writes. Any other request, any other branch than `gaugeline/<draft id>`, or a pull request that is not a
  draft is refused before it reaches the network. The list itself is frozen: no other code in the process
  can add an endpoint, change a method or widen a body. A path with a `.` or `..` segment (written plainly
  or as `%2e`) is refused, and the sender sends exactly the path the list checked, to `api.github.com`
  only. A test fails the build if the writer's code mentions a way to merge, send, publish or delete.
- **Files that run your automation.** At any depth and in any letter case, the writer never writes: anything
  starting `.git` (`.github`, `.gitmodules`, `.gitattributes`, `.gitlab-ci.yml`), `.husky`, `.circleci`,
  `.devcontainer`, `.vscode`, `.yarn`, `.npmrc`, `.yarnrc*`, `CODEOWNERS`, `package.json`, lock files,
  `pnpm-workspace.yaml`, `Makefile`, `Dockerfile*`, `docker-compose*`, `Jenkinsfile`, other CI
  configuration, and `*.sh`, `*.ps1`, `*.bat`, `*.cmd`. This list is a floor, not a fence: any source file
  your CI runs is code too. The fence is `allowedPrefixes` below, which is optional in this version;
  making it required is the owner's decision, not the writer's.
- **Page text that is not escaped.** The pull request's title and body go through Gaugeline's Markdown
  escaping first (ADR-0010 part 8). Every `<`, `>`, `&`, bracket, `#` and `*` is backslash-escaped, so
  nothing is a heading, a link, an image or HTML (an HTML comment shows as text). An `@name` or `@org/team`
  becomes a code span so nobody is notified, an issue reference (`#12`, `owner/repo#12`) and an address
  after `closes`, `fixes` or `resolves` becomes a code span so nothing is linked or closed, and a
  `javascript:`, `vbscript:`, `data:` or `file:` address becomes a code span so it is never a link. A
  title is one line and at most 256 characters once escaped (GitHub's limit; the cut is made at a whole
  escape or code span and ends with an ellipsis). The file contents are not touched: they are the change.
- **A payload that is not the one approved.** See checks 3 to 5 above.
- **A stop.** Set `GAUGELINE_WRITER_STOP=1` on the worker (any value but unset, empty or `0` stops), or
  pause applying for the organisation in the hosted app, and the writer stops before its next request.
  Both are checked before every request, not once at the start. Revoking the token is the last resort.

## Dry run is the default

A worker's configuration says `dry-run` or `write` for a kind. **Only the exact lower-case word `write`
writes.** Anything else, including `Write`, `true`, `1`, an empty value or no value, is a dry run: the
writer sends nothing and records the plan. (`resolveMode` is the one function that reads the value, and a
test holds the default.)

## What is recorded

One entry per job: the outcome (`dry_run`, `applied`, `apply_failed` or `refused`), the pull request's
address, GitHub's status code on a failure, or the reason it was refused (`kind`, `target`,
`kill switch`, `organisation paused`, `approval`, `draft`, `org`, `site`, `hash`, `withdrawn`, `expired`,
`payload`, `path`, `registry`). If a request fails in a way that is not an HTTP status (the network drops), the entry is `apply_failed` with
no status, and the error then goes on to your worker. Never the token, never GitHub's response body, never
the payload.

## What you set up

- A fine-grained GitHub token for the **one repository**, with **Contents: read and write** and **Pull
  requests: read and write**, in the worker's environment. It needs **no** `workflows` permission and
  **no** `administration` permission, and nothing on other repositories. The writer sends it in the
  `Authorization` header to `api.github.com` only and refuses redirects.
- **Protect your default branch** (required reviews and status checks). A token that can open a pull
  request can also merge one; the writer never asks, and branch protection makes sure nothing else can.
- **Mind your own CI.** The branch `gaugeline/<draft id>` is in **your repository**, not a fork. A
  workflow that runs on `pull_request` gets the repository's secrets for a branch in the same
  repository (a fork's pull request does not). So a draft that changes code your CI
  runs (a test file, a build script, a config) could run with those secrets before anyone has read it.
  Do both of these:
  1. In the site's worker configuration, set `allowedPrefixes` to the folders a draft may touch (for
     example `["content/", "public/menu/"]`; a name without a trailing slash is that one file). The
     writer then refuses a draft with a file anywhere else. Without it only the floor above applies.
  2. Restrict what a branch like this can reach: keep secrets out of workflows that run on pull requests
     from same-repository branches, or put them in an environment whose deployment branches or
     required reviewers stop `gaugeline/*` from using them, and require approval before workflows run
     where your plan allows it.

```ts
const target = {
  orgId: "0a000000-0000-4000-8000-00000000000a",
  siteId: "5e000000-0000-4000-8000-0000000000e5",
  owner: "northgate-studio",
  repo: "tidewater-bar",
  base: "main",
  allowedPrefixes: ["content/", "public/menu/"], // optional; the default is the floor only
};
```

## Email drafts (the `email` kind)

An approved `email` draft becomes one draft in **your own Gmail Drafts**, addressed to the site's configured
contacts, and is never sent. `applyEmailDraft` (or `emailDraftWriter(deps).apply(job)`) runs the same approval
checks as above, then builds one plain-text message and makes one request, `POST /gmail/v1/users/me/drafts`, to
`gmail.googleapis.com` with your OAuth access token, read at each request from the worker's environment variable `GAUGELINE_GMAIL_ACCESS_TOKEN`. The registry has that one request and no send. The one scope
to grant is `gmail.drafts.create`. The recipients come from your worker's configuration, never from the note. The
full page, with a runnable example and its real output, is
[Drafts in your own mailbox: Gmail](../guides/mailbox-drafts.md).

The trail entry's `ref` is Gmail's draft id; the extra reasons are `recipient`, `duplicate` and `disconnected`,
and `apply_failed` with the reason `reconnect` when Gmail answers 401 or 403. The weekly client update is not an
`email` apply job: the inbox skips it, and the agency's own mail path sends it ([agencies](./agencies.md)).

## Sanity drafts

The `sanity_draft` kind turns an approved fix into **a draft of one document** in your Sanity dataset, for an
editor to read and publish. The full walk-through, with a local example you can run, is
[Fixes as Sanity drafts](../guides/cms-fix-drafts.md). The rules, in short:

- The same approval checks as above (`checkApproval`, one function every kind uses), then the payload: a
  plain document id, a type, the new values and, for each, the SHA-256 of the text it holds now (`before`).
- **Two reads and one write per approval.** Read the live document and compare each field's digest with
  `before` (a different value is `stale`); read `drafts.<id>` (if it holds the approved text the job is done,
  if it holds anything else it is left alone: `draft exists`); then one `create` of `drafts.<id>`, a copy of the
  live document with the fix in it. Sanity refuses a create when the id exists, so a draft an editor started a
  moment ago cannot be overwritten.
- **The registry has two entries**: a read of one document and that one create. There is no request for a
  patch, a replace, a removal, an action, a query or a live id, and it is frozen like the GitHub one. The sender
  goes to `https://<projectId>.api.sanity.io` for the project in your configuration only, over https, with
  `redirect: "error"`, the token in the `Authorization` header only, and a fixed error message if the
  connection fails.
- **`allowedFields` is required** (`page.hours`), and prices, costs, fees, currencies, discounts, payments, slugs
  and secrets are refused even if listed. A dry run sends nothing at all.
- The trail records the outcome, the draft's id (`drafts.<id>`), the status or the reason. Never the token,
  never a response, never the client's text.

Status: the writer and its tests are built. The worker that claims jobs is G36's, and outcome rows in the
hosted decisions log arrive with it; until then the trail and the approvals lookup are interfaces.
