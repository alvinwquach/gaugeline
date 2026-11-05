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

### Links on the page

The link checks request at most 30 of the page's same-site links (the same host, with or without
`www`), the first 30 in document order after removing repeats, so the same page gives the same
sample every run. Each link is a `HEAD` request, or a `GET` when the server refuses `HEAD` (405 or
501). `mailto:`, `tel:` and `javascript:` links, `#` links to the page itself and links to other
sites are never requested. A link that answers 401, 403 or 429 is not reported as broken, and a page
that answers 200 but says "not found" (a soft 404) is out of scope.

Against the invented `links` fixture, a hardware shop with a dead garden-centre link in its header
and footer and a paint link that redirects, version 0.1.0 prints:

```text title=Output
✗ Links on this page go nowhere
    "Garden centre" <a href="/garden-centre"> returned 404
· Links on this page go through a redirect
    /old-paint (301) ends at /paint
✓ ai-crawlers-blocked
✓ app-link-dead
✓ app-name-mismatch
✓ app-smart-banner-mismatch
✓ canonical-elsewhere
✓ canonical-missing
✓ feed-broken
✓ feed-invalid
✓ feed-oversized
✓ host-duplicate
✓ llms-txt-broken-links
✓ llms-txt-stale-facts
✓ noindex
✓ quotable-facts-disagree
✓ redirect-chain
✓ robots-block
✓ sitemap-dead
✓ sitemap-host
✓ sitemap-missing
✓ sitemap-redirects
✓ thin-html

Checked all 6 links, 1 sitemap page.
2 to look at, 1 to fix first.
```

The output above is asserted by `packages/cli/src/__tests__/links.test.ts`.

### App stores

When the page links to an app (`apps.apple.com/.../id<digits>`, `play.google.com/store/apps/details?id=<package>`
or `market://details?id=<package>`), a run asks the store whether that app still exists. This is the
one place a run contacts a host other than the site, and only for an address the page itself
publishes ([ADR-0004](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0004-requests-the-checked-page-names.md)):

- Apple: one request to the public iTunes Lookup endpoint,
  `https://itunes.apple.com/lookup?id=<id>&country=<storefront>`. It needs no key. A link to a
  regional store (`/gb/app/...`) that has no result there is asked about once more in the US store.
- Google Play: one `GET` of the public listing page, of which only the status and the title are read.
- At most 5 apps per run, the first 5 on the page. Each request carries only the app id the page
  names and a storefront or language parameter: nothing about you, your machine or the run.

When the store cannot say (it answers 429, or the app is sold only in another country), the app is
"could not check", never "dead". To make no store requests at all, skip `app-link-dead` and
`app-name-mismatch`.

Against an invented bakery's page, replayed from a recording of the store answers
(`packages/testkit/cassettes/app-stores.json`), version 0.1.0 prints:

```text title=Output
✗ The app this page links to isn't in the store
    https://apps.apple.com/gb/app/hollyhock-classic/id6440000002?mt=8 names App Store app 6440000002, which App Store does not have
✗ The app this page links to isn't in the store
    market://details?id=example.hollyhock.classic names Google Play app example.hollyhock.classic, which Google Play does not have (404)
! The iPhone app banner promotes a different app
    apple-itunes-app names app-id=6440000009; the App Store link is id6440000001
✓ ai-crawlers-blocked
✓ app-name-mismatch
✓ broken-links
✓ canonical-elsewhere
✓ canonical-missing
✓ feed-broken
✓ feed-invalid
✓ feed-oversized
✓ host-duplicate
✓ links-via-redirect
✓ llms-txt-broken-links
✓ llms-txt-stale-facts
✓ noindex
✓ quotable-facts-disagree
✓ redirect-chain
✓ robots-block
✓ sitemap-dead
✓ sitemap-host
✓ sitemap-missing
✓ sitemap-redirects
✓ thin-html

Checked 1 sitemap page, all 4 app store links.
3 to look at, 2 to fix first.
```

The output above is asserted by `packages/cli/src/__tests__/app-store-links.test.ts`.

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

The same run reads `/llms.txt` once, and requests at most 10 of the links it lists (see
[How AI assistants read your site](guides/ai-assistants.md)).

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
✓ ai-crawlers-blocked
✓ app-link-dead
✓ app-name-mismatch
✓ app-smart-banner-mismatch
✓ broken-links
✓ canonical-elsewhere
✓ canonical-missing
✓ feed-invalid
✓ feed-oversized
✓ host-duplicate
✓ links-via-redirect
✓ llms-txt-broken-links
✓ llms-txt-stale-facts
✓ noindex
✓ quotable-facts-disagree
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
