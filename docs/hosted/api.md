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
  The value is never printed.
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
| `422`  | `unsupported_schema`, `secret_in_body`                                    | A schema this API does not take, or a value the service keeps secret           |

Every error is `{ "code": "...", "message": "..." }`.

An upload is **all or nothing**: the run and every finding are stored in one transaction, or nothing
is. Up to 10,000 findings are accepted in one request; one more and the whole body is refused. The
size cap is checked while the body is read, so a body that is too large is not read to the end.

What is kept of each finding: the check id, severity, title (up to 300 characters), **one line** of evidence (up
to 1,000 characters; longer is cut, line breaks become spaces), the address, and a fingerprint
computed by the server with the same function the command line uses for baselines, so a finding is the
same finding from one run to the next. A finding's `source` (a plan row) is not stored. The run keeps the counts, the ids of the failed
checks and the checks that could not run, not the lists of passed checks.

The server also scans the body for the values of the keys it holds itself (its database and service
keys) and for the token you just used. If one is there the upload is refused with `secret_in_body`
and nothing is stored.

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

## Versions

The `/v1` in the address is the API's version. Within v1, fields may be added to answers; a field is never
renamed or removed. The upload takes the result schemas that Gaugeline has published and still reads.

## In this version

What the code in this repository does today.

- The API is in `apps/hosted/lib/api` as functions from a `Request` to a `Response`, with the Route Handler files
  in `apps/hosted/app/api/v1`. The Next.js app around them (sign-in, the dashboard) is not built yet.
- There is no screen to make or revoke a token yet; `mintToken` and `revokeToken` in `lib/api/tokens.ts` do
  it, and the database holds only the hash.
- There is no rate limit yet. The size cap, the 10,000-finding cap and the token are the limits.
- Server Actions for what a signed-in person owns (rename a site, invite a member) need sign-in and are not part of this page.
- The API reads and writes the database as the `service_role` role inside a transaction, and checks that it
  is that role: never as the table owner, which would skip every row-level security policy. Runs and
  findings are written only through this token path.
