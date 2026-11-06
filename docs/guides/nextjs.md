# Next.js sites

Most sites Gaugeline checks are built with Next.js. It has its own quiet failures, and its own
noise: an audit that counts every address it finds can report thousands of "pages" that are really
the framework's own files.

## How a Next.js site is recognised

From its responses: an `x-powered-by: Next.js` or `x-nextjs-*` header, or, when a proxy strips
those, its HTML (scripts under `/_next/`, a `__NEXT_DATA__` block, or the App Router's
`self.__next_f`). On any other site the checks below are not run.

## Framework addresses are ignored

Build output, data and image endpoints (`/_next/...`), React Server Component payloads (`?_rsc=`)
and dev overlays (`/__nextjs...`) are not pages. Discovery leaves them out of the link and sitemap
samples, never requests them, and the summary says how many it ignored, for example
`40 framework addresses ignored.`

## The checks

- `next-draft-public` (fix first): a conventional draft or preview route (`/api/draft`,
  `/api/preview`, `/api/draft-mode/enable`, `/api/enable-draft`) turns draft mode on with no
  secret. Each route is asked once with a plain `GET`; no secret is sent or guessed. The evidence is
  the route and the cookie it set (`__prerender_bypass` or `__next_preview_data`).
- `next-preview-canonical` (fix first): the canonical address, `og:url`, `og:image` or a sitemap
  entry of a production page is on a preview domain (`vercel.app`, `netlify.app`, `pages.dev`).
- `next-stale-after-publish`: with a content source connected, a page still serving its cached copy
  (`x-nextjs-cache` or `x-vercel-cache` `HIT` or `STALE`, with an `Age`) more than ten minutes after
  its document changed. Content sources arrive in a later version; until then this check is not run.

A finding that compares what the server sends with what a visitor sees after scripts run (for
example `thin-html`) gets one more sentence on a Next.js site: the content is arriving only after
the page's scripts run.

## Example

Against the invented `next-like` fixture, a letterpress studio copied from a preview build, version
0.1.0 prints:

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://larkspur-git-main-studio.vercel.app/"> on http://larkspur.test/ (differs by scheme, host)
✗ Anyone can switch on draft mode
    /api/draft set __prerender_bypass with no secret
✗ The live site points search engines at a preview deployment
    canonical https://larkspur-git-main-studio.vercel.app/ is on a preview domain
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 1 link, 1 image, all 2 sitemap pages, 1 JavaScript file, all 4 draft routes. 40 framework addresses ignored.
3 to look at, 3 to fix first.
```

`canonical-elsewhere` reports the same canonical from the search side. Each check that passed also
prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/next.test.ts`.
