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
- **Not accepted.** The Action pull request comment (a `POST` to GitHub from the Action) stays parked and
  needs its own amendment.

No code ships with this amendment. CLAUDE.md rule 6 is not edited; the proposed sentence waits for the
owner's approval. Enforced by, when AG-19 lands: `eslint.config.js` and
`packages/core/src/__tests__/post-boundary.test.ts` name the one module, and a contract test asserts the
host allowlist and that no other file imports `node:http`, `node:https` or calls `fetch` for a provider.

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
