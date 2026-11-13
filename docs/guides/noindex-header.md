# Routes your page metadata does not reach

A site that is hidden from search until launch usually says so in its pages' metadata: a `robots` meta tag
with `noindex`. That tag only covers HTML pages that set it. The editor studio, the not-found page, an API
route and a file are not pages that set anything, so the tag never reaches them. The one thing that can keep
them out of search is an `X-Robots-Tag: noindex` header on the answer. `noindex-header-missing` asks a few
addresses and tells you which answer has no such header.

This is a **probing check**: it asks for addresses the site's pages do not link to, so it is off by default
and runs only with `--owner-consent` (or a `gaugeline.consent.json`), on sites you own or have permission to
test. It also needs your word that the whole site is meant to be hidden, in `gaugeline.hidden.json`.

## Set it up

Two things, both in your project folder:

```json title=gaugeline.hidden.json
{
  "hidden": [{ "match": "/*" }],
  "noindexRoutes": ["/studio", "/api/health"]
}
```

- A section that matches `/*` says the whole site is hidden. Without it the check does not apply and asks
  nothing, because it cannot know indexing is meant to be off.
- `noindexRoutes` is the list of routes to ask: up to 8, each a path starting with `/`. **Gaugeline never
  picks one itself**: it will not ask for `/studio` or an API route unless you wrote it here. The made-up
  not-found address (the one `not-found-200` uses) is always asked as well.

Each address gets one `GET` with no cookie and nothing sent, once per run, and at most 16 KiB of the answer
is read and never kept.

## An example: a pop-up cafe's studio

Dockside Coffee is an invented pop-up cafe that opens in December. The pages say noindex, the API route sends
the header, and the not-found page answers 404. The studio, served by the CMS, does not send the header.

<!-- fixture: noindex-header-missing -->

```sh title=Terminal
$ npx gaugeline dockside-coffee.example --owner-consent
```

```text title=Output
✗ This page asks search engines not to list it
    <meta name="robots" content="noindex, nofollow"> on https://dockside-coffee.example/
✗ A route the page metadata does not reach has no noindex header
    /studio answers 200 with no noindex in the X-Robots-Tag header or in the page
! Search engines can't find a list of your pages
    https://dockside-coffee.example/sitemap.xml returned 404; robots.txt has no Sitemap: line
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

3 to look at, 2 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The first finding is the site doing what
it should: the page is hidden on purpose. The second is the new check. In Next.js, add a `headers()` entry in
`next.config` for the studio's path, or one rule in the proxy that adds the header to every response while
indexing is off; for a studio served from another host, set it in that host's settings. Remove it at launch.

## What it says, and what it never says

| Answer                                                        | Result                                 |
| ------------------------------------------------------------- | -------------------------------------- |
| 2xx with `noindex` or `none` in `X-Robots-Tag`                | fine                                   |
| 2xx HTML with a robots meta tag saying `noindex`              | fine                                   |
| 2xx with neither                                              | a finding, with the route              |
| 401 or 403                                                    | fine: it is behind a login             |
| 404 or 410 on the made-up address                             | fine: the address does not exist       |
| 404 on a route you listed                                     | could not check: the route may be gone |
| 429, 5xx, no answer, or a private address the fetcher refuses | could not check, with the reason       |

The finding names the route and the status, never a header value or a word from the page. Without consent the check is not run at all; asked for by id, it says it could not check, with the reason, never
that it passed. A site with no whole-site `hidden` section is not asked at all.

The check's technical line in the [checks reference](/docs/checks) says what it relied on: the Next.js
`headers` and proxy pages for the fix, and nothing for the claim that a robots meta tag covers only pages
that set one, which Gaugeline could not read from an official page when the check was written.
