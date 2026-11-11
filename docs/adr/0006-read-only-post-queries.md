# ADR-0006: A POST is allowed for a documented read-only query

Status: accepted Date: 2026-11-11

## Context

ADR-0001 makes Gaugeline read-only by construction: every request to a checked site goes through the
fetcher, which sends only `GET` and `HEAD`. ADR-0005 added one exception, notifications to the
person's own channels, from one file. Three adapters now meet a wall that neither covers: the platform
answers a read only by `POST`.

- Wix Data Items are queried with `POST /wix-data/v2/items/query`.
- Some GraphQL APIs answer `POST` only (the GraphQL adapters, C-14 and C-17 to C-31).
- The Salesforce MCP source speaks JSON-RPC over `POST` (open question 21).

In each case the `POST` carries a question, not a change. The body is a query. Sending it with `GET`
is not possible, and leaving these platforms unread leaves their sites unchecked. The owner decided
on 11 November 2026 (open question 52): "POST is allowed for documented read-only query endpoints,
the same rule as GraphQL. Add an allowlist per adapter and a contract test that the request body is
never a write."

## Decision

A `POST` is allowed only when all four of these hold:

1. **From an adapter, through one fetcher method.** `fetcher.query(url, { allow, body })` in
   `packages/core/src/fetcher.ts` is the only code that sends a `POST` to a vendor's API. It is
   not a general `post()`: the method is fixed, the body is an object the fetcher serialises, and the
   content type is set by the fetcher.
2. **To an endpoint on that adapter's allowlist.** Each entry (`ReadOnlyQueryAllow`) names the exact
   host (from the adapter's configuration, never a wildcard), the method (`POST`), a path pattern
   (literal segments, and `*` for one whole segment) and a body shape:
   - `graphql-query`: one operation that parses as a `query`. A `mutation`, a `subscription`, a
     second operation and anything that is not a query document is refused. A persisted-query id (no
     document) is accepted only where the entry says persisted queries are allowed.
   - `json-query`: a JSON object whose top-level keys are all in the entry's list of query keys, and
     none is named like a write (`insert`, `update`, `delete`, `$set`, `mutation` and the like).
3. **The vendor documents that endpoint as a read, query or search endpoint.** The entry carries the
   documentation URL and the date it was checked. An entry whose page was not read is marked
   (`checked: null`), so a reviewer sees it.
4. **Every other rule is unchanged.** Keys come from the environment and never reach a log, a
   finding or a report. Private, loopback, link-local and metadata addresses are refused. A redirect
   is never followed, so the body and headers go to one origin only (a 3xx is refused). The answer is
   read under the same size cap, timeout and in-flight limit as a `GET`.

The request log records a query with its address and the id of the allowlist entry, marked `query`,
and never the body or a header.

## Consequences

- The fetcher can now send a `POST`, and a `POST` is checked three times: by the fetcher before it is
  sent, by the contract suite for every adapter (each entry declares `queryAllow`, any `POST` must
  match one, and the body is checked by the shared `isReadOnlyBody`), and by a scan of the source
  that fails if any other file builds a `POST`, `PUT`, `PATCH` or `DELETE`.
- Wix's native read (C-05b), the GraphQL adapters and the Salesforce MCP source can be built on the
  allowlist. Each is a separate branch that adds its own entries and its own docs.
- A cassette (the recorded-answers transport) still refuses a `POST`; recording a query is a later
  decision.

## What is still forbidden

- `PUT`, `PATCH`, `DELETE` and any other method, to any host, from any file.
- A `POST` that is not a query: a form, a login, a GraphQL `mutation` or `subscription`, a write or
  a create. Method override headers (`X-HTTP-Method-Override` and the like) are refused.
- A `POST` to an endpoint not on the adapter's allowlist, or to a host that is not the adapter's
  configured host, or over `http`.
- Following a redirect with a body, and sending the key to any host but the allowlisted one.
- Using a `POST` to probe a site. A `POST` query is for reading a platform's own API with the key the
  person gave; it is not a way to test a checked page (CLAUDE.md rule 14 is unchanged).
- Notifications stay as ADR-0005 says: `packages/core/src/notify/post.ts`, to the person's own
  channels.

## Alternatives

- **Refuse these platforms.** Lost because the check is the product: a site built on Wix could not be
  read for what its CMS says is published.
- **Let an adapter call `POST` itself, under review.** Lost because every adapter would carry its own
  copy of the rule, and one mistake would be a write to a client's platform.
- **A third reviewed module that sends `POST`, as ADR-0005 did.** Lost because the rule belongs where
  every request already passes: the fetcher's address rules, caps and log are what a query needs, and
  a separate module would copy them.
- **Trust the vendor's name for the endpoint ("query" in the path).** Lost because a path says nothing
  about the body; the body is what is checked.

## Cost

- A reviewer has to read one more path in the fetcher, and the allowlist entry of every new adapter
  (host, path, body shape, documentation page and date).
- A GraphQL persisted-query id cannot be read, so it is trusted only where the entry says the ids are
  stored queries.
- A vendor can document a read endpoint that has side effects (a search that counts as usage). The
  allowlist records the vendor's own documentation, which is the best evidence there is, and the date
  it was read.
- The check that a key name "looks like a write" is a word list. It stops the obvious; the entry's
  list of query keys is the real boundary.

## What would change it

A body shape that needs more than a query document or a list of query keys; a vendor that documents
an endpoint as a read and is found to change something; or a `POST` that any file other than the
fetcher or `notify/post.ts` builds.

## Enforced by

- `packages/core/src/fetch/read-only-query.ts` (`queryRefusal`: address, entry and body, pure)
- `packages/core/src/fetch/__tests__/read-only-query.test.ts` (the body shapes and the refusals)
- `packages/core/src/__tests__/fetcher-query.test.ts` (`fetcher.query` refuses everything else, never
  follows a redirect, and logs the allowlist id and never the body)
- `packages/core/src/__tests__/post-boundary.test.ts` (no other file builds a `POST`, `PUT`, `PATCH`
  or `DELETE`; the allowed files are `packages/core/src/fetcher.ts`, `packages/core/src/notify/post.ts` and the app page `packages/app/src/api.ts`)
- `packages/core/src/adapters/__tests__/contract.ts` and `packages/core/src/adapters/__tests__/contract-post-guard.test.ts` (the contract
  suite's guard, and proof it is not vacuous)
