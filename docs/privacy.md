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
sites are never requested. A link that answers 401, 403, 429 or 503 with Retry-After is not reported as broken: it is
listed as could not check, with its address, and a page
that answers 200 but says "not found" (a soft 404) is out of scope.

Against the invented `links` fixture, a hardware shop with a dead garden-centre link in its header
and footer and a paint link that redirects, version 0.1.0 prints:

```text title=Output
✗ Links on this page go nowhere
    "Garden centre" <a href="/garden-centre"> returned 404
· Links on this page go through a redirect
    /old-paint (301) ends at /paint
? broken-links could not be checked: refused automated readers (403) (/staff)
? broken-links could not be checked: rate limited (429) (/busy)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 to look at, 1 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by `packages/cli/src/__tests__/links.test.ts`.

### Images

The image checks request at most 20 of the page's same-site images, the first 20 in document order
after removing repeats. Each is a `HEAD` request (a `GET` only when the server refuses `HEAD`), and
only the response headers are read: `Content-Length` for the weight and `Content-Type` for the
format. No image body is downloaded, so a server that sends no `Content-Length` gives no weight
finding. Images on other hosts and `data:` images are never requested.

Against the invented `images` fixture, a haberdashery with 40 images, version 0.1.0 prints:

```text title=Output
✗ Some images on this page don't load
    <img src="/img/missing.png"> returned 404
! Images are requested at an enormous width
    1 image is offered at 3840 pixels or wider: /hero.jpg (3840w)
! Some images are very large files
    /img/heavy.jpg is 879 KB (Content-Length 900,000)
! Images still load from an old WordPress site
    1 image loads from /wp-content/uploads/: /wp-content/uploads/2019/05/old-sign.jpg
· Some images have no alt attribute
    2 images have no alt: /img/swatch-0.png, /img/swatch-1.png
· Images use older, heavier file formats
    16 of 20 sampled images are JPEG, PNG or GIF only: /img/heavy.jpg, /wp-content/uploads/2019/05/old-sign.jpg, /img/divider.png and 13 more
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 20 of 41 images.
6 to look at, 1 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/images.test.ts`.

### The app (gaugeline open)

`gaugeline open` starts a server on 127.0.0.1 only, so nothing else on your network can reach it.
The printed link works once: its one-time key, made new each start and never written to disk or
logged, is exchanged for a session cookie (HttpOnly, SameSite=Strict, held only by your browser for
that session) and taken out of the address bar. Requests from other websites are refused, whatever
they claim. The app saves nothing: no file is written in your
working folder or your home folder, and Ctrl+C leaves nothing behind.

### Private addresses

The address you type is trusted, private or not (with `--allow-private` on the command line, always
in the app). Nothing else is: a redirect, a link, a sitemap entry or a script that resolves to a
private, loopback or link-local address, other than the host and port you typed, is refused before
a request is sent. A public page can't make Gaugeline send requests into your network.

### App stores

When the page links to an app (`apps.apple.com/.../id<digits>`, `play.google.com/store/apps/details?id=<package>`
or `market://details?id=<package>`), a run asks the store whether that app still exists. Like the
payment-link and Sanity checks below, this contacts a host other than the site, and only for an
address the page itself publishes ([ADR-0004](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0004-requests-the-checked-page-names.md)):

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
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

3 to look at, 2 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by `packages/cli/src/__tests__/app-store-links.test.ts`.

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
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 25 of 30 sitemap pages, 3 of 4 feeds.
3 to look at, 2 to fix first.
```

These checks run from version 0.1.0; see [Quick start](quick-start.md).
Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by `packages/cli/src/__tests__/site-checks.test.ts`.

### JavaScript files

To look for private keys, a run reads the page's inline scripts and at most 15 of its same-site
script files (`<script src>` on the same host, with or without `www`), the first 15 in document
order. Each is one `GET`, and at most the first 5 MB of a file is read. Scripts from other sites are
never requested: they are not the site's to fix.

A key that is found is cut down to its first 6 and last 2 characters before anything else sees it,
so the whole key never reaches a finding, a log line or a report: `sk_liv…L2`. Publishable keys
(`pk_live_`, `pk_test_`) are meant to be public and are not reported.

### Sanity datasets

When the page's images come from `cdn.sanity.io`, the address names the Sanity project and dataset
(`cdn.sanity.io/images/<project>/<dataset>/...`). A run asks that dataset one question, with no
token, through Sanity's public query API:

```text
GET https://<project>.api.sanity.io/v2021-10-21/data/query/<dataset>?query={"count": count(*), "types": array::unique(*[]._type)}
```

That is the number of documents and the names of their types: never a document's contents. At most
2 datasets per run. A private dataset refuses the question, and that is a pass. To make no Sanity
request at all, skip `dataset-public` and `dataset-private-types`. What the answers mean:
[Private datasets](/docs/private-datasets).

### Email records

The email record checks run only when you pass `--dns`: without it, a run makes HTTP requests
only, and lists the four checks as could not run with the flag to use, so nothing is hidden. They
read two kinds of public DNS record for the checked host, and nothing else: `TXT` (at the host and at `_dmarc.<host>`) and `MX`. They never open a connection to a mail
server and never send mail. The host is read as given, without a leading `www.`: checking
`app.example.com` reads `app.example.com`'s records, not `example.com`'s, because working out the
parent domain needs the public suffix list. Lookups go through your machine's resolver, so they show
what it returns: a network with its own internal DNS can see different records than the public
does. A lookup that times out or fails is "could not check", never a finding. IP addresses,
`localhost` and names reserved for examples and tests (`.example`, `.test`, `.invalid`,
`.localhost`, `example.com`) are never looked up.

Against the invented `email-records` fixture, a bike shop with one SPF record per sending service
and a DMARC policy that only watches, with its DNS answers served from the fixture's `dns.json`,
`gaugeline bellwether.test --dns` with version 0.1.0 prints:

```text title=Output
! Your domain has two SPF records, which cancels both
    bellwether.test has 2 SPF records: "v=spf1 include:_spf.mailhost.test ~all"; "v=spf1 include:send.newsletter.test -all"
· Your DMARC policy only watches
    _dmarc.bellwether.test: "v=DMARC1; p=none; rua=mailto:dmarc@bellwether.test"

2 to look at, none to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/email.test.ts`.

### What it sends elsewhere

Nothing. A check runs on your computer and the results stay there unless you send them somewhere
yourself.

Why nothing is sent anywhere, and what enforces it: [ADR-0003 No telemetry, nothing sent](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0003-no-telemetry-nothing-sent.md).
