# Hosted: the runs API (v1)

The hosted version of Gaugeline (in progress, not released) takes the result of a run from your own
machine or CI and keeps it, so a site's history is in one place. This page is the reference for the
API the command line uploads to, and for the `--upload` option that does the uploading. The API is
plain JSON over HTTPS under `/api/v1`: one resource (a run, with its findings) and three requests.

**Your keys never leave your infrastructure.** Credentialed checks (a Stripe, Sanity or database key)
run in your CI or on your machine, as they do today. Only the result is uploaded: findings and one
line of evidence each, never page content, never a key.

## An example: the bar's nightly run

Northgate Studio looks after The Tidewater Bar. Its CI runs the check every night and uploads the
result. Northgate makes a token for the bar's site (once, in the hosted app; the token is shown once),
and puts it in the CI settings as `GAUGELINE_TOKEN`, with the address of the hosted app's API as
`GAUGELINE_UPLOAD_URL`:

```sh title=Terminal untested="Needs a hosted workspace, which does not exist yet; the output below was captured from the API's own tests."
$ GAUGELINE_TOKEN=glt_... GAUGELINE_UPLOAD_URL=https://hosted.example/api/v1 npx gaugeline tidewater-bar.example --upload
```

After the usual results, one line on stderr says what happened:

```text title=Output
Uploaded 2 findings to hosted.example.
```

The same request by hand:

```sh title=Terminal untested="Needs a hosted workspace, which does not exist yet; the output below was captured from the API's own tests."
$ npx gaugeline tidewater-bar.example --json > result.json
$ curl -sS https://hosted.example/api/v1/runs \
    -H "Authorization: Bearer $GAUGELINE_TOKEN" \
    -H "Idempotency-Key: nightly-2026-11-12" \
    -H "Content-Type: application/json" \
    --data-binary @result.json
```

```json title=Output
{
  "id": "132fe5e9-f0d9-4a01-ba0c-b7ec313903bf",
  "siteId": "a1000000-0000-4000-8000-0000000000a1",
  "startedAt": "2026-11-12T03:00:00.000Z",
  "findings": 2
}
```

Run the same `curl` again and the answer is `200` with the same body and the header
`Idempotent-Replayed: true`: one run, not two.

## Upload from the command line

`--upload` sends the run's result after the run. It needs two environment variables and nothing else:

| Variable               | What it is                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `GAUGELINE_TOKEN`      | The site's upload token (`glt_...`). Keep it a CI secret. It is sent only as a header |
| `GAUGELINE_UPLOAD_URL` | The hosted app's API address, ending in `/api/v1`. It must be https (or `127.0.0.1`)  |

With neither variable set (a laptop that is not wired to the hosted workspace), the check prints what it
always prints, exits as it always does, and adds one line on stderr, `Not uploaded: set GAUGELINE_TOKEN to the site's upload token.`:

<!-- fixture: quick-start -->

```sh title=Terminal
$ npx gaugeline shop.example --upload
```

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://shop.example/tools"> on https://shop.example/ (differs by path)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

1 to look at, 1 to fix first.
```

- The body is exactly what `--json` prints (schema 2). Nothing else is added.
- **An upload failure never changes the exit code.** A refused token, a server that is down, a missing
  variable: the check still finishes with the exit code it would have had, and one plain line says
  what went wrong, for example `Could not upload: hosted.example answered 401: The token is not valid.`
  or `Not uploaded: set GAUGELINE_TOKEN to the site's upload token.`
- If the value of a key from your environment (a variable whose name has KEY, TOKEN, SECRET,
  PASSWORD, WEBHOOK and so on) is anywhere in the result, **nothing is sent** and the line says which
  variable: `Not uploaded: the result contains the value of MY_SERVICE_API_KEY, so nothing was sent.`
  The value is never printed. The check reads every decoded string of the result (every field, and the
  names in `sampled`), so a key with a quote, a backslash or a non-ASCII character is found too, not only
  a key that looks the same once JSON has escaped it. A string shaped like a key (a Stripe secret key, a
  Sanity token and the other shapes the `secret-in-js` check knows) stops the upload even when no variable holds it.
- The text of the server's answer is cleaned of control and escape characters before it is printed.
- The upload carries an `Idempotency-Key` made from the result, so a CI job that is run again with the
  same result makes one run, not two.
- With `--json`, stdout is still only the JSON; the line goes to stderr. `--quiet` hides the success line, never a failure.

## Authentication

Every request carries a per-site token: `Authorization: Bearer glt_...`.

- A token belongs to **one site**. It can upload to that site and read that site's runs, and nothing
  else. Naming another site (`?site=` on any request) is a `403`; a run of another site is a `404`.
- Only a SHA-256 hash of the token is stored, with an 8-character prefix to find it. A token is shown
  once, when it is made. If you lose it, make another and revoke the old one; a revoked token stops
  working at once.
- A missing, wrong or revoked token is the same `401`, so the answer does not say which.

## `POST /api/v1/runs`

Body: the JSON that `gaugeline <address> --json` prints. Schemas **1** and **2** are accepted (schema 1
is the older shape without `couldNotCheck` and `sampled`). Unknown fields are refused, so a body cannot carry page content.
Headers: `Authorization` (required), `Idempotency-Key` (optional; 1 to 255 printable characters).

| Status | Code                                                                      | When                                                                           |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `201`  |                                                                           | The run and all its findings were stored                                       |
| `200`  |                                                                           | The same `Idempotency-Key` and body as an earlier upload: that run is returned |
| `400`  | `invalid_json`, `invalid_body`, `invalid_site`, `invalid_idempotency_key` | The body or a header is not valid; the message names the field                 |
| `401`  | `unauthorized`                                                            | No token, or one that is not valid                                             |
| `403`  | `wrong_site`                                                              | `?site=` is not the token's site                                               |
| `409`  | `idempotency_key_reused`                                                  | The key was used for a different body                                          |
| `413`  | `body_too_large`, `too_many_findings`                                     | Over 8 MB, or over 10,000 findings                                             |
| `422`  | `unsupported_schema`, `secret_in_body`                                    | A schema this API does not take, or a key or token in the body                 |

Every error is `{ "code": "...", "message": "..." }`.

An upload is **all or nothing**: the run and every finding are stored in one transaction, or nothing
is. Up to 10,000 findings are accepted in one request; one more and the whole body is refused. The
size cap is checked while the body is read, so a body that is too large is not read to the end.

What is kept of each finding: the check id, severity, title (up to 300 characters), **one line** of evidence (up
to 1,000 characters; longer is cut, line breaks become spaces), the address, and a fingerprint
computed by the server with the same function the command line uses for baselines, so a finding is the
same finding from one run to the next. A finding's `source` (a plan row) is not stored. The run keeps the counts, the ids of the failed
checks and the checks that could not run, not the lists of passed checks.

The server scans every decoded string of the body (every field, and object keys; `\u` escapes are
read as the receiver would read them) for the token you just used and for strings shaped like a key
(the same shapes the command line looks for). If one is there the upload is refused with
`secret_in_body` and nothing is stored; the answer does not say which it was and never repeats it.
It does **not** compare the body with the server's own environment: that would let anyone with a token
guess at the server's secrets one upload at a time. Comparing with your environment's values is the
command line's job, because the command line knows them. A NUL character (`\u0000`) anywhere is a
`400`: the database cannot store it.

**Addresses are text.** The `url` of a finding is whatever address the check reported, and an address
can be `javascript:` or `data:` text. Anything that shows it as a link (the dashboard, the weekly
update) must check the scheme and only link `http:` and `https:` addresses.

## `GET /api/v1/runs`

The token's site's runs, newest first.

| Query    | Meaning                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------ |
| `site`   | Optional. If given it must be the token's site (`403` otherwise)                                 |
| `since`  | Only runs that started after this time, an ISO 8601 time with an offset (`2026-11-01T00:00:00Z`) |
| `limit`  | 1 to 200, default 50                                                                             |
| `cursor` | The `nextCursor` of the previous page                                                            |

```json title=Output
{
  "runs": [
    {
      "id": "132fe5e9-f0d9-4a01-ba0c-b7ec313903bf",
      "siteId": "a1000000-0000-4000-8000-0000000000a1",
      "startedAt": "2026-11-12T03:00:00.000Z",
      "finishedAt": "2026-11-12T01:55:07.702Z",
      "summary": {
        "schema": 2,
        "url": "https://tidewater-bar.test/",
        "high": 1,
        "medium": 1,
        "low": 0,
        "total": 2,
        "passed": 2,
        "failed": ["broken-links"],
        "couldNotCheck": [],
        "sampled": { "links": { "seen": 40, "taken": 30, "limit": 30 } }
      }
    }
  ],
  "nextCursor": null
}
```

`finishedAt` is when the server received the upload. `nextCursor` is `null` on the last page. The cursor is
opaque: pass it back unchanged. Pages never repeat or skip a run, even when a new run arrives between two requests.

## `GET /api/v1/runs/:id/findings`

The findings of one run, with `limit` (1 to 5000, default 1000) and `cursor` as above, in a stable order.
A run that does not exist, or belongs to another site, is a `404`.

```json title=Output
{
  "findings": [
    {
      "id": "3e5d8d9b-c9fe-412a-8238-45ce62f4a982",
      "checkId": "broken-links",
      "severity": "high",
      "title": "Broken link on the menu page",
      "evidence": "/menu links to /drinks-1 (404)",
      "url": "https://tidewater-bar.test/menu",
      "fingerprint": "af01eb2087d5951b"
    }
  ],
  "nextCursor": null
}
```

## Agent reads: pending drafts and run history

A registered agent ([the agent registry](./agent-registry.md)) reads with its own token,
`Authorization: Bearer gla_...`, never a site's upload token. Its token reads; it cannot upload a run, read a
run's findings, decide a draft or change anything. Two scopes, each checked by the
[agent policy](./agent-policy.md) once per request, before anything is read:

| Request                             | Scope          | What it returns                                                                       |
| ----------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `GET /api/v1/drafts?status=pending` | `read:pending` | the organisation's drafts waiting for a decision, newest first                        |
| `GET /api/v1/drafts/:id`            | `read:pending` | one of them; `404` once it is decided or expired, or if it is not this organisation's |
| `GET /api/v1/runs?site=<id>`        | `read:runs`    | one site's runs, the same answer as the site's own token gets; `site` is required     |

**Pending** means no decision yet and younger than 72 hours (an approval after 72 hours is refused). The
organisation is the token's: no query names it, and another organisation's draft or site is a `404`, the same
as one that does not exist. Query: `site` (optional on `/drafts`), `limit` (1 to 50, default 20), `cursor` (the
`nextCursor` of the previous page). `status` may only be `pending`.

### An example: the morning digest reads the bar's inbox

Northgate Studio registers a "Morning digest" agent with `read:pending` and `read:runs`, and a "Menu fixer"
with `draft:email` only. This is the output of the API's own handlers against the seeded test database
(`apps/hosted/app/api/__tests__/agent-api.test.ts` seeds the same way), the digest's token in `$DIGEST`:

```sh title=Terminal untested="Needs a hosted workspace, which does not exist yet; the output below was captured from the API's handlers on the seeded test database."
$ curl -sS "https://hosted.example/api/v1/drafts?status=pending" -H "Authorization: Bearer $DIGEST"
```

```json title=Output
{
  "drafts": [
    {
      "id": "a1d20000-0000-4000-8000-0000000000a2",
      "siteId": "a1000000-0000-4000-8000-0000000000a1",
      "kind": "email",
      "title": {
        "untrusted": true,
        "source": "draft title",
        "text": "Your menu link is fixed",
        "truncated": false,
        "strippedDirectives": 0
      },
      "excerpt": {
        "untrusted": true,
        "source": "draft excerpt",
        "text": "The drinks page is back: /menu now links to /drinks.",
        "truncated": false,
        "strippedDirectives": 0
      },
      "payloadSha256": "ba75ce8fdae2a08b01b04f4a7b7ebeda0277255a389dc10da59f5cd4a2d676a0",
      "createdAt": "2026-11-13T09:15:00.000Z",
      "expiresAt": "2026-11-16T09:15:00.000Z",
      "findingIds": []
    }
  ],
  "nextCursor": null
}
```

The same request with the Menu fixer's token, which has no `read:pending`:

```json title=Output
{
  "code": "denied",
  "message": "Refused by the agent policy: scope.",
  "reason": "scope"
}
```

That answer is a `403`, and the refusal is a row in the deny log (`tool` `read:pending`, `reason` `scope`).
`GET /api/v1/runs?site=b1000000-0000-4000-8000-0000000000b1` with the digest's token, a site of another agency,
is a `404` `not_found`.

**Only safe fields.** A draft's payload never leaves as it is: `payloadSha256` is the SHA-256 of the exact
payload, the hash an approval of it records. `title` is the email's subject, the pull request's title, or a
Sanity draft's document type and id; `excerpt` is the start of the body (a pull request's files are not in
it), or for a Sanity draft the names of the fields it sets, never their values. Both are what an agent wrote,
and an agent's text may quote a page, so each is labelled `untrusted: true`, cleaned like page text (hidden
characters shown as `\u{...}`), cut to 120 and 280 characters, and anything shaped like a key or a Gaugeline
token is replaced with `[redacted]`.

| Status | Code                                                        | When                                                                    |
| ------ | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `400`  | `invalid_query`, `invalid_cursor`                           | `limit` over 50, `status` other than `pending`, a bad `site` or cursor  |
| `401`  | `unauthorized` (with `reason` when the token is an agent's) | no agent token, or an unknown, disabled or revoked agent                |
| `403`  | `denied`                                                    | no scope, a kill switch, or another policy refusal; `reason` says which |
| `404`  | `not_found`                                                 | another organisation's draft or site, or a draft that is not pending    |
| `429`  | `denied`                                                    | the agent's rate limit or daily cost ceiling                            |
| `503`  | `agents_not_configured`                                     | the server has no agent login (`GAUGELINE_AGENT_DATABASE_URL`)          |
| `503`  | `agents_unavailable`                                        | the agent login is set but was refused (uploads keep working)           |

**How it is held.** The API answers an agent's token on a third database login,
`GAUGELINE_AGENT_DATABASE_URL`: a member of `gaugeline_agent` and nothing else. A login that is anything
else, or does not answer, turns off the agent reads only (`503` `agents_unavailable`; it is tried again a
minute later, and the server's log says `refused` or an error code, never the address): uploads and site tokens
keep working. That role holds no table. It runs `private.agent_list_pending` and `private.agent_list_runs`,
which take the organisation from the token and call the policy (`private.agent_authorize`) exactly once with
their scope; a refused call reads nothing. An agent's token never reaches the `service_role` connection.
`GAUGELINE_AGENTS_OFF` on the server refuses every agent request before the database. Nothing here approves:
assistants plan, people approve.

**Why agents read runs with their own token and not a site's.** A site's token can also upload runs; an agent
that only reads should hold a credential that only reads. One agent token covers the organisation's sites,
each request still names one site, and revoking the agent stops every read at once. The run's findings stay on
the site's token for now (`GET /runs/:id/findings` with an agent token is a `401`).

## Versions

The `/v1` in the address is the API's version. Within v1, fields may be added to answers; a field is never
renamed or removed. The upload takes the result schemas that Gaugeline has published and still reads.

## In this version

What the code in this repository does today.

- The API is in `apps/hosted/lib/api` as functions from a `Request` to a `Response`, with the Route Handler files
  in `apps/hosted/app/api/v1`. The Next.js app around them (sign-in, the dashboard) is not built yet.
- There is no screen to make or revoke a token yet; `mintToken` and `revokeToken` in `lib/api/tokens.ts` do
  it, and the database holds only the hash.
- There is no rate limit on a site's token yet (an agent's token has the policy's), and old idempotency keys are not pruned yet. The size cap, the 10,000-finding cap and the token are the limits.
- Server Actions for what a signed-in person owns (rename a site, invite a member) need sign-in and are not part of this page.
- Two database logins, two variables, both secrets that stay on the server. `GAUGELINE_MIGRATE_URL` is the
  owner (the role that creates the tables) and only `db:migrate` reads it. `GAUGELINE_DATABASE_URL` is the
  app login: a separate role that is not the owner, not a superuser, `NOINHERIT`, and a member of
  `service_role` and `authenticated` only (like Supabase's `authenticator`). The server checks the app login
  once, when it starts (`instrumentation.ts`, outside any transaction), and **refuses to start** if it skips
  row-level security, which is what a login as the owner does.
- Each request then works as `service_role` for one transaction (`set local role`, which ends with the
  transaction) and checks that it is that role. Nothing in the API issues `reset role`; a test scans for it.
  Runs and findings are written only through this token path.
