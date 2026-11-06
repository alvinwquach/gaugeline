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
