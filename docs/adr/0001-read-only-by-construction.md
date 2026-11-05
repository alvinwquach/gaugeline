# ADR-0001: Read-only by construction

Status: accepted Date: 2026-11-05

## Context

The Security page promises "A check never changes anything on your site", and the Reference page
"What it can and can't write" lists nothing Gaugeline writes to a checked site. People point
Gaugeline at production sites, sometimes with keys in the environment. One check that sends a
`POST`, even by accident, breaks that promise on someone else's live site.

## Decision

The only code that can make a request to a checked site is the fetcher (`packages/core/src/fetcher.ts`)
and the transport under it (`packages/core/src/transport.ts`). The fetcher has no code path for any
method but `GET` and `HEAD`: `assertReadOnly` refuses anything else before a socket is opened, on the
first request and on every redirect. Checks receive a fetcher; they cannot make their own requests.

## Alternatives

- **A read-only mode flag.** Lost because a mode can be switched off, and the default would have to
  be argued about forever. A capability that does not exist cannot be switched on.
- **Trusting each check to only read.** Lost because there will be about 89 checks, written over
  years by different people. One mistake is enough, and review is not a guarantee.

## Cost

A check that needs something other than `GET` or `HEAD` (submitting a form to test it, for example)
cannot be written. Form checks read the rendered page instead. Every new kind of network access
(DNS records, a connector API) needs its own reviewed module rather than a quick `fetch`.

## What would change it

A check that people need and that is impossible without sending a non-read request to the checked
site. That would need a new, separately reviewed decision, not an exception in a check.

## Enforced by

- `packages/core/src/__tests__/fetcher.test.ts` (`assertReadOnly` refuses POST, PUT, PATCH and
  DELETE, and a cast `POST` through `get()` throws)
- `eslint.config.js` (in `packages/core/src`, the `fetch` global and `node:http`/`node:https`
  requests are banned outside the transport)
- `packages/cli/src/__tests__/no-phone-home.test.ts` and
  `packages/fixtures/src/__tests__/server.test.ts` (promise tests: only `GET` and `HEAD` reach the
  checked site)
