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

1. **From an adapter, through one fetcher method, by id.** `fetcher.query(url, { allow, body })` in
   `packages/core/src/fetcher.ts` is the only code that sends a `POST` to a vendor's API. It is
   not a general `post()`: the method is fixed, the content type is set by the fetcher, and `allow`
   is the id of an entry the caller cannot write itself (next point). The body is serialised once;
   the text that is checked, parsed back, is the text that is sent.
2. **To a registered endpoint on that adapter's allowlist.** Each entry (`ReadOnlyQueryAllow`) is
   written once, in the adapter's own file, and registered at module load with `registerQueryAllow`
   (`packages/core/src/fetch/query-registry.ts`), which checks it and freezes it. The fetcher looks
   the id up in that registry and refuses an id nobody registered, so code that merely holds a
   fetcher cannot invent an endpoint. A scan of the source fails if any file but an adapter's
   registers an entry or calls `.query(` with one. An entry names:
   - the host: the vendor's exact host (no wildcard), or `{ configured }` for a host the person set
     in the adapter's configuration (a GraphQL endpoint). For a configured host the adapter passes
     the validated host with each request; the fetcher accepts one exact host name, and the path and
     body rules below still apply. This is the one value the caller supplies, and the reason the
     private-address refusal stays on;
   - the method (`POST`) and a path pattern (literal segments, and `*` for one whole segment; no
     segment is named like a write, so `/orders/delete` cannot be registered);
   - a body shape:
     - `graphql-query`: one operation that parses as a `query`. A `mutation`, a `subscription`, a
       second operation and anything that is not a query document is refused. A persisted-query id
       is accepted only alone and only when the entry names that id (`persisted`); an id beside a
       document is refused, because the id could name a stored mutation.
     - `json-query`: a JSON object whose top-level keys are all in the entry's list of query keys.
       The whole body is walked: a key starting with `$` must be one of the entry's `operators`, no
       nested key is named like a write (`insert`, `update`, `deleteitem`, `bulkDelete`, `$set`,
       `purge`...), no string value reads as a write statement (`DELETE FROM x`), and a key with
       `enums` takes only those values. The entry's lists are the boundary; the word list is a
       second screen.
3. **The vendor documents that endpoint as a read, query or search endpoint.** The entry carries the
   documentation URL and the date it was checked. An entry whose page was not read is marked
   (`checked: null`), so a reviewer sees it.
4. **Every other rule is unchanged.** Keys come from the environment and never reach a log, a
   finding or a report. Private, loopback, link-local and metadata addresses are refused. A redirect
   is never followed, so the body and headers go to one origin only (a 3xx is refused). The headers
   a caller may add exclude anything that changes the method or the framing (`x-http-method*`,
   `x-method-override`, `x-original-method`, `content-length`, `cookie`, `expect`, `upgrade`, `te`,
   `range`, `user-agent`, `accept-encoding`...). The answer is read under the same size cap,
   timeout and in-flight limit as a `GET`.

The request log (`fetcher.history()`, the app's Pages checked view and the saved requests file,
schema 2) records a query with its address and the id of the allowlist entry, as kind `query`,
method `POST`, and never the body, a header or the key. A saved file of schema 1 is still read.

## Consequences

- The fetcher can now send a `POST`, and a `POST` is checked three times: by the fetcher before it is
  sent, by the contract suite for every adapter (each entry lists the frozen entries its file
  exports as `queryAllow`, the suite checks they are the registered objects, any `POST` must match
  one, and the body is checked by the shared `isReadOnlyBody`), and by an AST scan of the source
  that fails if any other file builds a `POST`, `PUT`, `PATCH` or `DELETE`, opens a connection as a
  client, or registers an endpoint.
- Wix's native read (C-05b), the GraphQL adapters and the Salesforce MCP source can be built on the
  allowlist. Each is a separate branch that adds its own entries and its own docs.
- A cassette (the recorded-answers transport) still refuses a `POST`; recording a query is a later
  decision.
- `packages/app/src/api.ts` is on the scan's allowed list for the app's own page: it makes one POST
  (to start a run) and opens the event stream, both to relative `/api/*` addresses on the local
  server that served the page, never to a checked site.

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

- `packages/core/src/fetch/read-only-query.ts` (`queryRefusal`: address, entry and body, pure) and
  `packages/core/src/fetch/query-registry.ts` (entries are checked, frozen and looked up by id)
- `packages/core/src/fetch/__tests__/read-only-query.test.ts` (the body shapes, the word screen and
  the refusals)
- `packages/core/src/__tests__/fetcher-query.test.ts` (`fetcher.query` refuses an unregistered id,
  an entry the caller wrote, a stored id beside a document, a body that changed between the check and
  the send, nested writes and method-override headers; never follows a redirect; logs the allowlist
  id and never the body)
- `packages/core/src/__tests__/post-boundary.test.ts` and `packages/core/src/__tests__/post-scan.ts`
  (a TypeScript-AST scan: no other file builds a `POST`, `PUT`, `PATCH` or `DELETE`, opens a
  connection as a client or registers an endpoint; the allowed files are
  `packages/core/src/fetcher.ts`, `packages/core/src/notify/post.ts`,
  `packages/core/src/transport.ts` for the socket, and the app page `packages/app/src/api.ts`; a
  self-test runs each way of evading it)
- `packages/core/src/adapters/__tests__/contract.ts` and
  `packages/core/src/adapters/__tests__/contract-post-guard.test.ts` (the contract suite's guard,
  and proof it is not vacuous)
- `packages/core/src/__tests__/requests-file.test.ts` (queries reach the saved requests file,
  schema 2, with the allowlist id and no body)
