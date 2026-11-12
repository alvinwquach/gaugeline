# Hosted: applying an approved fix

When someone approves a draft in [the inbox](./inbox.md), the hosted service does not change anything.
It queues an apply job. **Your own worker**, on your machine or in your CI, claims the job and runs the
writer (`packages/writer`) with **your own GitHub token**. The hosted service never holds a token that
can write ([What it can and can't write](../writes.md#fixes-you-approve-hosted), ADR-0010).

This page covers the `pull_request` kind. Sanity drafts (X71) and Gmail drafts (X75) use the same rules
and arrive in their own pull requests. Nothing changes a live field.

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
2. Look for an open pull request from `gaugeline/<draft id>`. If there is one, record it and stop, so the
   same draft never opens two.
3. Create the branch `gaugeline/<draft id>` (`POST .../git/refs`).
4. For each file, read its current version on the base branch, then commit the new content to the new
   branch (`PUT .../contents/<path>` with `branch` set; without it GitHub would write to the default
   branch, so the writer refuses a request that has no branch).
5. Open the pull request as a draft (`POST .../pulls` with `draft: true`).

## What the writer refuses

- **Anything not on its list.** The writer knows six GitHub requests: the three reads above and the three
  writes. Any other request, any other branch than `gaugeline/<draft id>`, a file under `.git` or `.github`,
  or a pull request that is not a draft is refused before it reaches the network. A test fails the build
  if the writer's code mentions a way to merge, send, publish or delete.
- **A payload that is not the one approved.** The approval row holds the SHA-256 of the exact payload
  the person approved (the edited one after Edit first). The writer hashes the job's payload and refuses
  it if the hashes differ, then checks it against the same fixed shape the inbox used.
- **A stop.** Set `GAUGELINE_WRITER_STOP=1` on the worker, or pause applying for the organisation in the
  hosted app, and the writer stops before its next request. Both are checked before every request, not
  once at the start. Revoking the token is the last resort.

## What is recorded

One entry per job: the outcome (`dry_run`, `applied`, `apply_failed` or `refused`), the pull request's
address, GitHub's status code on a failure, or the reason it was refused. Never the token, never GitHub's
response body, never the payload.

## What you set up

- A fine-grained GitHub token for the one repository, with `contents` and `pull requests` write, in the
  worker's environment. The writer sends it in the `Authorization` header to `api.github.com` only and
  refuses redirects.
- **Protect your default branch** (required reviews and status checks). A token that can open a pull
  request can also merge one; the writer never asks, and branch protection makes sure nothing else can.

Status: the writer and its tests are built. The worker that claims jobs is G36's, and outcome rows in the
hosted decisions log arrive with it; until then the trail is an interface.
