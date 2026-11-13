# AI routes that answer anyone

A menu helper, a "write my bio" button or a support chat on a small business's site usually talks to a route on
the site's own server, and that route talks to a model. If the route has no login, no limit and a catch-all
error handler, a stranger can use it as a free model, read what it was told to do, or learn which provider and
model sit behind it from the error it shows. `ai-endpoint-open` asks the routes you list and tells you which
ones answer anyone.

This is a **probing check**: it asks routes the site's pages do not link to, so it is off by default and runs
only with `--owner-consent` (or a `gaugeline.consent.json`), **on sites you own or have permission to test**. It
also needs your list of routes, in `gaugeline.ai.json`.

## Set it up

```json title=gaugeline.ai.json
{ "modelEndpoints": ["/v1/models", "/api/chat", "/api/assist"] }
```

- `modelEndpoints` is the list of routes to ask: up to 8, each a path starting with `/`, no `*`, `?` or `#`.
  **Gaugeline never picks one itself**: it will not ask for `/api/chat` or `/v1/models` unless you wrote it here.
- The file also holds `aiCrawlers` ([How AI agents read your site](agent-readiness.md)); each key is optional.

Each route gets one `GET` with no cookie, no `Authorization` header and no query, once per run. At most 16 KiB of
the answer is read and never kept. Gaugeline never sends a `POST`: a chat route that needs one answers 405 to a
`GET`, which is shown as closed and says nothing about what a `POST` without a login would get. Test that route
yourself, or with a tool built for active testing.

## An example: a tea room's menu helper

Cedar Row Tea Room is an invented tea room. Its menu helper's route `/v1/models` lists the models behind it to
anyone, `/api/chat` passes the provider's own error text through, and `/api/assist` wants a `POST` and says so.

<!-- fixture: ai-endpoints -->

```sh title=Terminal
$ npx gaugeline cedar-row-tea.example --owner-consent
```

```text title=Output
✗ An AI route on your site answers anyone or shows the provider's error text
    ./models answers 200 and lists 2 models to anyone, with no login
! An AI route on your site answers anyone or shows the provider's error text
    ./chat answers 401 with the provider's own error text: a provider error type, a provider message, a key fragment
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 to look at, 1 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. A finding names the route (the text report shortens `/v1/models` to `./models`) and what it saw. It
never prints a model's name, a message or any part of a key: the error is described by signs ("a provider error
type", "a key fragment"), not quoted.

## What it says

| Answer to the `GET`                                                                                                                       | Result                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 2xx JSON that lists models (an OpenAI-style `data` list or a `models` list)                                                               | high: lists its models to anyone, with the count |
| 2xx JSON that is a model's reply (choices, candidates, a text block, a response)                                                          | high: replies to anyone                          |
| any answer with a provider error type, a provider message, a masked key fragment, a stack trace, a server file path or an SDK error class | medium: names the signs, none of the text        |
| 401, 403 or 405, or a plain message                                                                                                       | fine                                             |
| 404, 429, a 5xx with no such text, no answer, or a private address the fetcher refuses                                                    | could not check, with the reason                 |

Without consent the check is not run, and asked for by id it says it could not check, with the reason, never that
it passed. A site with no `modelEndpoints` list is not asked at all.

The shapes of a model list, a reply and a provider's error are from memory, not from the providers' own pages,
which could not be reached when the check was written: the check's technical line in the
[checks reference](/docs/checks) says so.

## If you find one

- **Lists its models, or replies to anyone**: put a login, a signed session or a rate limit in front of the route,
  and cap what one visitor can spend. Revoke the provider key if the route has been open for long, and read the
  provider's usage log.
- **Shows the provider's error**: catch the error on the server, log it there, and send back a short message of
  your own with a plain status. If a key fragment was shown, treat the key as seen.
