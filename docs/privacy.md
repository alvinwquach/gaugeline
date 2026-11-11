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

The one exception to "public pages" is a **probing** check, which asks a route that should be
protected for what it protects, with no login (the download route check, below). It is off unless you
pass `--owner-consent` or add a `gaugeline.consent.json`, and it is for sites you own or have
permission to test.

### Keys

Some features read a system you own, such as your Sanity dataset, Stripe account or Printful store (see
[Products and prices](./products-and-prices.md)). Their keys are read from environment variables only:
no config file, flag or prompt accepts one. Those requests are `GET` only, with the key in a request
header and never in the address. Before any message about a system leaves Gaugeline (a notice, an
error, a `--verbose` line), every key value in it is replaced with `[redacted]`. A variable set to an
empty string counts as not set.

### Databases

If `gaugeline.sources.json` names a Postgres or Supabase database
([A database as a source](./connectors/postgres.md)), Gaugeline connects to it with the connection
string in the environment variable you name, and only when a check asks for one of its named queries
or runs one of its [data assertions](./guides/data-assertions.md), or when `gaugeline.switches.json`
or `gaugeline.freshness.json` names one of its queries
([Switches, sold out and capacity](./guides/switches-and-availability.md),
[Data freshness](./guides/data-freshness.md)).
It is not a request to the checked site and does not go through the fetcher. It sends one statement
at a time, a single `SELECT` that passed the statement check, inside a read-only transaction that is
always rolled back, with a timeout and a cap of 5,000 rows. The connection string, its password and
any Supabase key are replaced with `[redacted]` in every message, and a Supabase `service_role` key
is refused without being used. The rows stay on your computer or in your CI. A data assertion that fails prints its row count and
only the columns its `evidence` list names, for the first 20 rows; every other column is dropped as
soon as it is read.

### Switches, the 86 list and capacity

If `gaugeline.switches.json` exists, Gaugeline reads the state it names from where you change it, and
the pages it names from the site. A `sanity:` source is one field of the first published document of a
type: one `GET` of Sanity's query address, published content only, with a token (`SANITY_TOKEN`, only
for a private dataset) in a header and never in the address. A `db:` source is a named query, read as
described under Databases. The pages are fetched with `GET` through the same fetcher as every other
page, at most 16 different pages named in the file, each once. The state, the pages and the item names
stay on your computer or in your CI; what a finding prints is escaped, and any key or connection string
in it is replaced with `[redacted]`. Without the file none of this happens.

### Data freshness

If `gaugeline.freshness.json` exists, Gaugeline reads the pages it names outright, from the same
allowance of 16 pages as the switches file, each once with `GET`, and looks at the pages the run reads
anyway for the ones its patterns match. It reads the newest sync time or a figure from where you keep
it: a `sanity:` source is one field of the first published document of a type (one `GET`, published
content only, a token in a header and never in the address), and a `db:` source is a named query, read
as described under Databases. The times, the figures and the page text stay on your computer or in
your CI; what a finding prints is escaped, and any key or connection string in it is replaced with
`[redacted]`. Without the file none of this happens.

### Content model changes

If `gaugeline.model.json` exists, Gaugeline reads the schema file it names from your disk and asks Sanity
only for numbers and ids. Every question is one `GET` of Sanity's query address for published
documents, with a token (`SANITY_TOKEN`, only for a private dataset) in a header and never in the
address, and every answer is a count or a list of document ids (`count(*[_type == "article" &&
!defined(summary)])`, or the first three ids in id order). No document, title, field value or text a
client wrote is requested, so none reaches your computer, your CI or a report. Where a listing page
has entries missing, the page's own public addresses are sent in the query and ids come back. The
listing and block pages are read like every other page, with `GET` through the fetcher, from the same
allowance of 16 pages as the switches and freshness files. Without the file none of this happens. See
[Content model changes on Sanity](./sources/sanity-schema.md).

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

### Download routes (a probing check)

With `--owner-consent` (or a `gaugeline.consent.json`), the `gated-download-open` check asks each
download route of the site for its file as a visitor with no session and no purchase would, and
reports the routes that hand it over ([Paid downloads and delivery](delivery.md#a-download-route-that-hands-the-file-to-anyone)).
**Run it only on sites you own or have permission to test.** Without consent nothing is asked.

What it sends, per route:

- One `GET`. No cookie, no `Authorization` header, no `Referer`, and not the secret of a protected
  preview, even when one is set for the page. The headers are the user agent and
  `Accept-Encoding: identity`, so what is read is the start of the file itself.
- Never a `POST`, never a form, never a login, never an id it was not shown. A dynamic route is asked
  only for an address a link on your page gave.
- At most 10 routes per run, in sorted order, so the same page gives the same ten every run. The rest
  are named as not asked.

What it reads: the status, the headers, and at most 1,024 bytes of the body, after which the
connection is closed. Those bytes are compared with a short table of file signatures (`%PDF`, `PK`,
`ID3` and a few more) and then thrown away: the file's content is never stored, logged, printed or put
in a report, and neither is the query string of the address. A redirect to a sign-in address is not
followed; a redirect anywhere else is followed one hop.

A link that carries its own signature and expiry (a signed link) is not asked, and neither is a link
straight to a file such as `/files/menu.pdf`: that is a static file, which the paid file checks
cover.

### Signed-in routes (a probing check)

`gaugeline check <folder> --routes --base <address>` has two parts. The first reads your repository: the
route files of a Next.js app folder and the middleware file beside it, as text, on your computer. Nothing
is run and nothing is sent anywhere. The second asks the running site at `--base`, and only with
`--owner-consent` (or a `gaugeline.consent.json`): each route your code treats as signed-in only is asked
for its page as a visitor with no session would. **Run it only on sites you own or have permission to
test.** Without consent nothing is asked.

What it sends, per route:

- One `GET`. No cookie, no `Authorization` header, no `Referer`, no query string, and not the secret of a
  protected preview. The headers are the user agent, `Accept` and `Accept-Encoding: identity`. There is no
  option to send a session, a cookie or a token, and an address with a user name or a password in it is
  refused.
- Never a `POST`, never a form, never a login, never an id it was not given. A route with a dynamic
  segment is not asked.
- Redirects are not followed, so a sign-in page is not requested.
- At most 30 routes per run, in sorted order, and at most 5 requests at a time. The rest are named as
  not probed.

What it reads: the status, a few headers (the redirect target and the content length), and at most 64 KB
of the body, which is searched for a sign-in form (a password field) and thrown away. A page is never
stored, logged, printed or put in a report, and neither is a redirect target's query string. What a
finding shows is the route's path, the status, the size of the page and the name of your own route file.

How it finds the routes and what it can't see: [Routes that are hidden, not protected](protected-routes.md).

### Orders, emails and webhooks (delivery and platform)

`gaugeline delivery --paid --sent` and `gaugeline platform --webhooks` read two accounts you own,
Stripe and Resend, with keys from `STRIPE_API_KEY` and `RESEND_API_KEY`
([Paid downloads and delivery](delivery.md#paid-and-the-receipt-never-went-out)). They are the only
commands that contact `api.stripe.com` and `api.resend.com`, and only when you run them with the key
set: this is a destination you configured, so [ADR-0003](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0003-no-telemetry-nothing-sent.md)
holds.

What they send: `GET` requests only, through the fetcher, with the key in an `Authorization` header and
never in an address. They list Checkout Sessions (with the payment intent and charge expanded, to tell
a refund), the emails Resend lists as sent, Stripe's webhook endpoints and the events with undelivered
webhooks. They never send, resend, replay, retry or enqueue anything, and no request has a body.

What they read and keep: per order, when it was paid and the address on it; per email, when it was
sent and its recipients. The subject, the sender, the body, an amount, a name, an order id and an event
payload are not read into anything. In memory, the addresses are hashed (SHA-256 of the lower-cased
address) into one `Map` that is dropped when the comparison returns; no address and no hash is
printed, logged, written to a file or put in `--json`. A webhook endpoint is reduced to its host: its
path, its query and its signing secret are dropped.

What they print: two counts and UTC days for the comparison, and for a webhook endpoint its host, how
many events are waiting and the age of the oldest. Every message that mentions a system is passed
through the redactor that blanks both keys first.

### Rendered emails (gaugeline emails)

`gaugeline emails <folder>` reads the `.html` files, and the `.txt` beside them, that your email export
wrote ([Transactional emails](guides/emails.md)). It reads them as text: it never renders a template,
runs your code, connects to a mail account or sends a message, and it has no key and no option to do
any of those.

Without `--base` it makes no request at all. With `--base https://your-site.example` it makes `GET` and
`HEAD` requests, through the fetcher, to links and images on that one site, at most 30 links and 20
images for each email. A link to another site is never requested, and neither is an unsubscribe,
opt-out or preferences link on any site, because a `GET` to one can unsubscribe a person.

What it prints: the file and the line, the template variable or the address that is wrong, and counts.
An address in the evidence is cut before its `?`, because a real export can hold a customer's token in
a query string; text from an email is escaped, and a finding passes through the same redactor as every
other. The files you point it at should still be rendered from sample data, not exported from a real
customer's send.

### Renewals (gaugeline renewals)

`gaugeline renewals <address>` (and `--renewals` on the page check) asks for the dates that decide when a
site goes dark ([Renewals](guides/renewals.md)). Every request is `GET` or `HEAD`, through the fetcher.

- **The domain's registry.** One `GET` of IANA's bootstrap file (`data.iana.org/rdap/dns.json`) and one
  `GET` of the registry's public RDAP server for the domain's name. No key. The name of the domain you
  check is sent to the registry, as it is by any RDAP lookup. Gaugeline never uses WHOIS.
- **The site's own hosts.** One `HEAD` of the bare domain and of its www, not followed, to read the
  certificate's names and dates off the connection. Nothing is downloaded.
- **GitHub and Vercel, only for a token you set.** `GET https://api.github.com/rate_limit` with the token
  in a header, and `GET https://api.vercel.com/v5/user/tokens/current` and `/v9/projects/<name>` for the
  projects you list. The token goes in a request header to that host only, and is never put in an
  address, a log, a finding or a report. Only a date and a Node.js version are read from the answers: not
  a token's name or scopes, a project's repository or any other field.

What it prints: dates, the registrar's name, the status words the registry uses (such as "client hold"),
the host names, and the names of the variables that hold the tokens. Text from a registry is escaped, and
a finding passes through the same redactor as every other. It never renews, buys, logs in or changes
anything.

### Saving the requests (--save-requests)

By default a run keeps what it asked for in memory and writes only the report. `--save-requests <file>`
also writes the request log and the page's data to one JSON file you name, so you can see exactly
which addresses a check requested and what the page declared. It is off unless you pass it, and it
is a separate file: the `--json` result is the same with or without it.

**The file may contain page content (the page's title and first 200 readable words, and its
structured data), so do not commit it or share it.** Keep it out of your repository: add its name
to `.gitignore`. Gaugeline's own `.gitignore` lists `gaugeline-requests.json`.

<!-- fixture: quick-start -->

```sh title=Terminal
$ npx gaugeline shop.example --save-requests gaugeline-requests.json
```

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://shop.example/tools"> on https://shop.example/ (differs by path)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

1 to look at, 1 to fix first.
```

The passed-check lines are left out above. On stderr, after the results, it says where the file went:

```text
Request log written to gaugeline-requests.json. It may contain page content: do not commit it.
```

What is in the file:

- `schemaVersion`, `generatedBy`, a `notice` that says what is in it, the address that was checked and
  when.
- `requests`: one row for every address the check requested, with its kind (`page`, `link`,
  `image`, `sitemap`, `feed`, `script`, `extra-page` or `other`), the method (`GET` or `HEAD`), the
  status or the reason there was none, how long it took in milliseconds and, for a redirect, where it
  pointed.
- `page`: the address the page ended at, its title and canonical, how many words a visitor can read
  without JavaScript, the first 200 of them, and each structured data block (parsed, or as raw text
  with the parser's message when it did not parse).
- `truncation`: what was cut, if anything (see below).

It holds no request or response headers and no page bodies beyond that. A row looks like this:

```json
{
  "url": "https://shop.example/tools",
  "kind": "sitemap",
  "method": "HEAD",
  "status": 200,
  "ms": 14
}
```

**Redaction.** Every string in the file goes through the same `redact()` as findings, reports and
error messages: key-shaped text (Stripe, AWS, GitHub, Slack, Google and similar keys, JSON Web
Tokens, `Bearer` and `Basic` values) and the values of secret-looking query parameters (`token`,
`access_token`, `api_key`, `apikey`, `key`, `secret`, `password`, `sig`, `signature`, `auth`) become
`[redacted]`. The cut for the size limit is made after redaction, so a cut cannot leave the front of
a key behind.

**Size limit.** A page keeps at most 256 KB (262,144 bytes of UTF-8) of text across its title,
canonical, first words and structured data together (`MAX_SAVED_PAGE_BYTES`), and the file lists at
most 1,000 requests (`MAX_SAVED_REQUESTS`). When something is cut the file says so itself: `page.truncated`
names the fields that were cut, a structured data block that was cut has `"truncated": true`,
`page.blocksOmitted` counts blocks left out, and `truncation` at the top has `truncated: true`, the
limits, how many requests were made and saved, and a sentence for each cut. A structured data block
that does not fit whole is kept as its first part, as raw text. The two limits are constants in
`@gaugeline/core`; there is no flag to raise them.

**Where it works.** The page check (`gaugeline <address>`) and `gaugeline launch` accept it.
`gaugeline plan`, `open`, `view`, `digest`, `printed`, `snapshot`, `cutover`, `verify` and `run` do
not: they stop with exit code 2 and one sentence saying which commands do.

**Where it is written, and when it can fail.**

- The file is claimed before the first request. If the path is a folder, its folder does not exist
  or it cannot be written, Gaugeline stops with exit code 2 and one sentence, and nothing has been
  requested.
- A file that is already there is replaced, whole, when the check finishes. If the check cannot run
  (the site does not answer), a file this run created is removed again and an existing file is left
  as it was.
- Writing the file never changes the exit code, with one exception: if it cannot be written (above, or
  the disk fills up before the end), the exit code is 2.
- A new file is created readable by its owner only (mode 0600) on macOS and Linux. Windows does not
  use these modes: the file has the permissions of the folder it is in, so choose a folder only you can
  read. An existing file keeps the permissions it had.
- Nothing is sent anywhere. The file is never uploaded, and no other command reads it.

**How the file will change.** It has its own version, `schemaVersion`, which has nothing to do with
the `schema` number of `--json`. Its shape is published as a JSON Schema,
[`packages/core/schema/requests.v1.json`](https://github.com/alvinwquach/gaugeline/blob/main/packages/core/schema/requests.v1.json)
(draft 2020-12), generated from the code and checked in CI (`pnpm schema:check`) the way the result's
is. A published file is never edited in place: CI fails any change to the shape, adding a field included,
unless it comes with a new `schemaVersion` and a new schema file (`requests.v2.json`). The old file
stays in the package so a script can pin to it. Version 1 allows no unknown keys, so a script that
validates against it will notice if a later version adds one. What a version-2 file would change is
named in the changelog, and the changeset for it follows the semver rules in STABILITY.md.

### The app (gaugeline open)

`gaugeline open` starts a server on 127.0.0.1 only, so nothing else on your network can reach it.
The printed link works once: its one-time key, made new each start and never written to disk or
logged, is exchanged for a session cookie (HttpOnly, SameSite=Strict, held only by your browser for
that session) and taken out of the address bar. Requests from other websites are refused, whatever
they claim. The app saves nothing: no file is written in your
working folder or your home folder, and Ctrl+C leaves nothing behind.

The app's Leaks & access view shows counts and type names only: how many documents a public Sanity
dataset has and the names of their types, never a document, and no way to open one. A key found in
JavaScript is shown cut down to its first 6 and last 2 characters, as the check emits it, and the
whole value never reaches the app. Showing the view asks nobody for anything: it uses what the
run already read.

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

### Query counts (gaugeline query)

`gaugeline query <folder>` reads files and, only when `SANITY_PROJECT_ID` is set, asks your dataset for counts. One `GET` of Sanity's query address for each document type your queries name, published content only:

```text
GET https://<project>.api.sanity.io/v2021-10-21/data/query/<dataset>?query={"total":count(*[_type == "popup"]),"p0":count(*[_type == "popup" && defined(date)]),...}&perspective=published
```

The answer is whole numbers: how many documents of the type exist and how many have each field. No document, no field value and no sample is read. A token (`SANITY_TOKEN`, only for a private dataset) goes in a header and never in the address. A type with many fields is sent in two or more parts when the address would be too long, and stderr says so. What a finding prints is the type, the field's name, the file and line, and two numbers. Without `SANITY_PROJECT_ID` nothing is requested. What the findings mean: [Checking your queries](/docs/query-check#what-it-reports).

### Duplicate documents (gaugeline query --dupes)

`--dupes` is the one option of `gaugeline query` that reads more than counts. It needs `SANITY_PROJECT_ID` and sends one more `GET` for each document type your queries name, published content only:

```text
GET https://<project>.api.sanity.io/v2021-10-21/data/query/<dataset>?query=*[_type == "menuItem"]{_id,"slug":slug.current,title}&perspective=published
```

The answer is the id, the slug and the title of each document: nothing else is requested. Gaugeline keeps them in memory only long enough to group them and keeps the groups. A finding prints the type, the shared slug or title, and the ids of the documents that share it. That is text an editor wrote, escaped before it is printed, and it appears only when two documents share it. The token goes in a header and never in the address. Without `--dupes` none of this is requested. What the findings mean: [Checking your queries](/docs/query-check#the-same-thing-twice).

### Generated content (gaugeline query --totals and --refs)

`--totals "type:stated=parts"` and `--refs "type:path"` need `SANITY_PROJECT_ID` and send one `GET` for each rule (ten at most), published content only. The dataset does the comparing, so what comes back is document ids and whole numbers:

```text
GET https://<project>.api.sanity.io/v2021-10-21/data/query/<dataset>?query={"documents":count(*[_type == "mealPlan"]),"unstated":*[_type == "mealPlan" && !defined(targetCalories)] | order(_id)[0...101]{_id},...,"mismatched":*[_type == "mealPlan" && ... && targetCalories != coalesce(math::sum(days[].meals[]->calories), 0)] | order(_id)[0...101]{_id}}&perspective=published
```

A totals rule gets the count of documents of the type, the `_id` of those with no stated number, the `_id` of those whose stated number is not the sum of its parts (the filter does the comparing, so neither number is returned), and two counts. A refs rule gets, for each document with a reference to something unpublished, its `_id`, two counts and the ids of the missing targets (the `_ref` of a reference is an id, not content). No stated number, no part, no title or text and no other field is requested. A test seeds a dataset with marker text and fails if the marker, or a stated number, appears in an answer, a request or the output. This is a narrower reading than the first plan for the check, which returned the two numbers of each document; the cost is that a finding does not print them. The rule text is checked field by field and is never pasted into the query as typed. The token goes in a header, never in the address.

### Saved baselines (gaugeline query --save and --against)

`--save <file>` writes one file into the folder you ran the command in, after a normal run, and `--against <file>` reads it. The file holds the check id, the document type, the field path and the file path of each gap, a key made of those four, a schema number and the time. It holds no token, no document, no field value, no line number and no count, and the run that makes it sends the requests the plain run sends (a `GET` of counts for each type), not one more. A test seeds a dataset with ids, slugs and titles, runs with a token in the environment, and fails if any of them is in the file. What it is for: [Before a restructure](/docs/query-check#before-a-restructure).

### Unused fields (gaugeline query --unused)

`--unused` makes no request. It reads the `.ts`, `.tsx`, `.js`, `.jsx` and `.mjs` files (and `.graphql` and `.gql` files) of the folder you give it, and the files they import, with the TypeScript compiler, and it never reads anything inside `node_modules`. It needs no `SANITY_PROJECT_ID` and no token, and it does not read an environment variable: its code is not given the environment. A field's name, a file and a line are all that reach the output; no document, no value and no key does. What the output means: [Fields fetched but never rendered](/docs/query-check#fields-fetched-but-never-rendered).

### Written queries (gaugeline query --suggest)

`--suggest --type <name>` reads the field names and kinds of the type from your schema file on disk (`sanity schema extract`, or `--schema <file>`) and asks your dataset how many of the newest 50 published documents have each field. It needs `SANITY_PROJECT_ID` and sends one `GET`, published content only, with a count for each field (more only if the address would be too long, each for fewer fields):

```text
GET https://<project>.api.sanity.io/v2021-10-21/data/query/<dataset>?query={"total":count((*[_type == "resource" && !(_id in path("drafts.**"))] | order(_updatedAt desc)[0...50])),"p1":count((...)[defined(title)]),...}&perspective=published
```

The answer is whole numbers: how many documents were counted, and how many of them have each field. No document, no field value and no sample is requested, so none reaches your computer, a log, a report or the output; a test seeds a dataset with marker strings and fails if one appears in the output, a request or an answer. The query is built from the schema file, so a field name from it is checked against Sanity's own pattern before it goes into the query, and the type name is checked too. A token (`SANITY_TOKEN`, only for a private dataset) goes in a header and never in the address. What the output means: [Writing the query in the first place](/docs/query-check#writing-the-query-in-the-first-place).

### Written routes (gaugeline query --page)

`--page --type <name> --out <folder>` reads exactly what `--suggest` reads, and sends exactly the same requests: the schema file from your disk, and one `GET` of counts over the newest 50 published documents (more only if the address would be too long). No document, field value or sample is requested, so none can reach your computer, a log or the files it writes; a test seeds a dataset with marker strings and fails if one appears in the output, a request or any of the three files. Nothing is sent to your dataset and no `POST` is made.

What it adds is writing to your disk, and only there: three new files (`queries.ts`, `types.ts`, `page.tsx`) in the folder `--out` names, which must be the folder you ran the command in or one inside it. It never overwrites a file unless you pass `--force`, never writes outside that folder, and prints every path it wrote. No git command is run. The files contain field names and the counts' percentages from your schema and dataset, which can reveal how a type is shaped, so read them before you commit them. What the files are: [Checking your queries](/docs/query-check#starting-a-page-from-your-content); the boundary: [What it can and can't write](/docs/writes#local-files-it-writes).

### Mutations (gaugeline query --mutations)

`--mutations` reads the writes in your code and compares them with a schema file on your disk. It sends nothing: no request is made for a mutation, none could be (the code that reads them cannot import an HTTP client, and a test fails the build if it does), and it needs no `SANITY_PROJECT_ID`, no token and no network. The schema file and your source files are read from disk and stay there. A finding prints the file and line of a write and the names of the fields it writes, escaped. It never prints a value from your code. What the findings mean: [Checking your queries](/docs/query-check#mutations-checked-without-running-them); the proof: [What it can and can't write](/docs/writes#the-promise-test).

### GraphQL (gaugeline query --graphql)

`--graphql` sends one request for the schema, and it is a `GET` with the introspection query in the address, which is how GraphQL over HTTP sends a query that way:

```text
GET <endpoint>?query=query+IntrospectionQuery{__schema{queryType{name}types{kind+name+fields(includeDeprecated:true){name+type{...TypeRef}}interfaces{name}possibleTypes{name}}}}fragment+TypeRef+on+__Type{...}
```

The query is a constant: no text from your repository is in it, so a mutation or a subscription in your code is parsed and counted and never reaches a request, and the introspection query does not ask for the mutation or subscription root. Gaugeline never sends a `POST`, so a server that takes `POST` only is answered with exit 2 and the `--schema <file>` option, which reads the schema from your disk and asks nothing. The endpoint is the address you gave, or Sanity's GraphQL address for your project. A token goes in an `Authorization` header and never in the address: `SANITY_TOKEN` to Sanity's own address, and `GRAPHQL_TOKEN` to any other, so a Sanity token is never offered to another server; a token is not sent over plain `http`, except to an address on this computer. The answer is the names of types and fields, which stay in memory and are not printed except as the name of a field your code asks for that the schema lacks. For a Sanity endpoint the same document types are then counted as under Query counts above: one `GET` for each type, counts only. Any other endpoint is not counted, and the output says so. What the findings mean: [Checking your queries](/docs/query-check#graphql-the-same-way).

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
