# Is the editor studio cached?

The editors of a small site work in a studio: the Sanity Studio embedded at `/studio`, a CMS admin page, a
dashboard. It changes whenever the studio is updated, and it is the one part of the site that only the team
looks at. A response that may be stored can be shown again by a browser or a shared cache after the studio
has changed, so an editor can be handed an old page of it. `studio-response-cacheable` asks the studio's
route and tells you whether its answer says it must not be stored.

This is a **probing check**: it asks for an address the site's pages do not link to, so it is off by default
and runs only with `--owner-consent` (or a `gaugeline.consent.json`), on sites you own or have permission to
test. It also needs you to name the route.

**A note on sources.** Documentation checked on: 2026-11-13. MDN and Sanity's documentation could not be
reached when this page was written (the build session's network policy refused them), so what was read is
the MDN content repository on GitHub at one commit [docs]: [HTTP caching](https://raw.githubusercontent.com/mdn/content/92395f809c3067b56ef5ea031faf864cdaee1c55/files/en-us/web/http/guides/caching/index.md),
"Don't cache": "The `no-cache` directive does not prevent the storing of responses but instead prevents the
reuse of responses without revalidation", and "If you don't want a response stored in any cache, use
`no-store`". For the fix, Next.js 16.4.1 [headers](https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/05-config/01-next-config-js/headers.mdx):
headers are set "on the response to an incoming request on a given path". That an editor is handed a stale
studio because of it is **uncited**: the check says what the response says, and not what a cache does with it.
Grounded Code was not connected.

## Set it up

One file in your project folder, next to your consent:

```json title=gaugeline.studio.json
{
  "studioRoutes": ["/studio"]
}
```

- `studioRoutes` is the list of routes to ask: one to four, each a path starting with `/`, with no `*`, `?`
  or `#`. **Gaugeline never picks one itself**: it will not ask for `/studio` unless you wrote it here. Without
  this file the check does not apply and asks nothing.
- Each route gets one `GET` with no cookie and nothing sent, once per run. Redirects are followed, as a
  browser would, and the answer you land on is the one judged. At most 4 KiB of it is read and never kept.

## An example: a pop-up cafe's studio

Dockside Coffee is an invented pop-up cafe. Its menu and opening times are edited in a studio at `/studio`,
which answers with `Cache-Control: public, max-age=3600`: it may be kept for an hour.

<!-- fixture: studio-cacheable -->

```sh title=Terminal
$ npx gaugeline dockside-coffee.example --owner-consent
```

```text title=Output
· The editor studio can be cached
    /studio answers 200 with a Cache-Control header that has no no-store
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

1 to look at, none to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. In Next.js, add a `headers()` entry in
`next.config` for the studio's route (`Cache-Control: no-store`); for a studio served from another host, set
it in that host's settings.

## What it says, and what it never says

| Answer                                                                          | Result                           |
| ------------------------------------------------------------------------------- | -------------------------------- |
| 2xx with `no-store` in `Cache-Control`                                          | fine                             |
| 2xx with no `Cache-Control` header                                              | a finding, with the route        |
| 2xx with `Cache-Control` but no `no-store` (`private`, `no-cache`, `max-age=0`) | a finding, with the route        |
| 401 or 403                                                                      | fine: it is behind a login       |
| 404, 410, 429, 5xx, no answer, or a private address refused                     | could not check, with the reason |

`no-cache` and `private` are not enough: `no-cache` still lets a response be stored and reused after it is
checked, and the check asks for the one directive that says never to store it. The finding names the route
and the status, never a header value or a word from the page. Without consent the check is not run at all;
asked for by id, it says it could not check, with the reason, and never that it passed. A site with no
`gaugeline.studio.json` is not asked at all.
