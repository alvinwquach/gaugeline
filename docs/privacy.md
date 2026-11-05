# Privacy and safety

Exactly what a check reads, and what it never touches.

- Read-only. A check never changes anything on the site.
- No login. It sees only what anyone on the internet can see.
- Nothing is sent to us. The check runs on your computer or in your CI, and the report stays there.
- The Sanity check reads only the number of documents and the names of their types. It never downloads document contents.

## In this version

What the code in this repository does today. The sections above describe the product as published on the site.

### What Gaugeline requests

Gaugeline only asks the site you name for public pages, the same way a search engine or a visitor's
browser would:

- `GET` and `HEAD` requests only. It never submits a form, never sends a `POST`, `PUT`, `PATCH` or
  `DELETE`, and never logs in.
- At most five requests at a time, with the user agent `Gaugeline/0.1 (read-only site check)`.
- Each address once per run.

### robots.txt, sitemaps and feeds

When a check needs them, a run reads the site's `/robots.txt`, its sitemaps and the feeds the page
advertises. They are read once and shared by every check, and a run whose checks need none of them
requests none of them. The limits are fixed (see [Security](security.md#how-much-a-run-requests)):

- **Sitemaps.** It reads the sitemaps that robots.txt names on `Sitemap:` lines, or `/sitemap.xml`
  when it names none. A sitemap index is followed one level. Sitemap files are read in order until
  there are enough entries for the sample, and never more than 10. A gzip sitemap (`.xml.gz`) is
  read decompressed.
- **Sitemap pages.** At most 25 of the listed pages are requested, the first 25 in the sitemap's
  order, so the same sitemap gives the same sample every run. Each is a `HEAD` request (a `GET`
  when the server refuses `HEAD`). An entry after the 25th is never requested, so a dead page at
  position 400 is not found.
- **Feeds.** At most 3 of the feeds the page advertises (`<link rel="alternate">` with an RSS or
  Atom type) are read, the first 3 on the page. Each is read up to the 5 MB body limit.

A robots.txt that answers 404, or with an HTML page, counts as "no robots file", the way search
engines read it. One that answers 5xx or not at all is unknown, and no robots or sitemap finding is
reported from it.

Against the invented `sitemap-feeds` fixture, a tea room whose sitemap lists 30 pages and whose page
advertises four feeds, the run requests 25 sitemap pages and 3 feeds. It reports:

```text title=Output
✗ The feed this page advertises is broken
    http://feeds.test/events/feed returned 404
✗ Your sitemap lists pages that don't exist
    1 of 25 sampled sitemap entries return an error: /closed-room (404)
! Your sitemap lists old addresses that redirect
    1 of 25 sampled sitemap entries redirect: /old-menu (301 to /menu/01)
✓ canonical-elsewhere
✓ canonical-missing
✓ feed-invalid
✓ feed-oversized
✓ host-duplicate
✓ noindex
✓ redirect-chain
✓ robots-block
✓ sitemap-host
✓ sitemap-missing
✓ thin-html

Checked 25 of 30 sitemap pages, 3 of 4 feeds.
3 to look at, 2 to fix first.
```

These checks run from version 0.1.0; version 0.0.x runs one check (see [Quick start](quick-start.md)).
The output above is asserted by `packages/cli/src/__tests__/site-checks.test.ts`.

### What it sends elsewhere

Nothing. A check runs on your computer and the results stay there unless you send them somewhere
yourself.

Why nothing is sent anywhere, and what enforces it: [ADR-0003 No telemetry, nothing sent](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0003-no-telemetry-nothing-sent.md).
