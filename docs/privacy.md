# Privacy and safety

Exactly what a check reads, and what it never touches.

- Read-only. A check never changes anything on the site.
- No login. It sees only what anyone on the internet can see.
- Nothing is sent to us. The check runs on your computer or in your CI, and the report stays there. The one exception is something you switch on: `--upload`, with a token and an address you set, sends the findings and their evidence lines (no page content, no keys) to your own hosted workspace. See [Hosted: the runs API](/docs/hosted/api).
- The Sanity check reads only the number of documents and the names of their types. It never downloads document contents.

## In this version

What the code in this repository does today. The sections above describe the product as published on the site.

### What Gaugeline requests

Gaugeline only asks the site you name for public pages, the same way a search engine or a visitor's
browser would:

- `GET` and `HEAD` requests. It never submits a form, never sends a `PUT`, `PATCH` or `DELETE`, and
  never logs in. The one exception for reads is a documented read-only query endpoint on an adapter's
  allowlist ([ADR-0006](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0006-read-only-post-queries.md)):
  a content system such as Wix answers a read only to a `POST`, so an adapter may send one `POST` whose
  body is a query (a GraphQL `query`, or a JSON object of the vendor's documented query keys) to the
  vendor's API address and nowhere else. A mutation, a write-looking key, a path not on the list or a
  redirect is refused before anything is sent. Every such query is listed in the request log (the
  Pages checked view and the saved requests file) with the id of the endpoint that allowed it; the
  body and the key are never kept. The other `POST`s are notifications to your own channels
  ([ADR-0005](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0005-notifications-post-to-your-own-channels.md)).
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

`nav-utm-lost` asks each header and footer link of the page once more, as a `HEAD` request (a `GET` only when
the server refuses `HEAD`), with three test campaign tags added to its address
(`utm_source=gaugeline-check`, `utm_medium=menu-test`, `utm_campaign=nav-links`: Gaugeline's own values). It
asks at most 40 destinations on the same site, header links first, and nothing is submitted or clicked.
`nav-link-not-200` reads the plain answers of those same links: a link the link sample already asked reuses that
answer, and each of the others is one more `HEAD` (or `GET`), never twice.

Against the invented `links` fixture, a hardware shop with a dead garden-centre link in its header
and footer and a paint link that redirects, version 0.1.0 prints:

```text title=Output
✗ Links on this page go nowhere
    "Garden centre" <a href="/garden-centre"> returned 404
! A menu link drops campaign tags
    1 of 4 menu links lose campaign tags: header › Paint: the 301 at hop 1 from /old-paint to /paint drops utm_source, utm_medium, utm_campaign. Gaugeline's own test values were used (utm_source=gaugeline-check, utm_medium=menu-test, utm_campaign=nav-links).
· Links on this page go through a redirect
    /old-paint (301) ends at /paint
? broken-links could not be checked: refused automated readers (403) (/staff)
? broken-links could not be checked: rate limited (429) (/busy)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 4 of 6 other pages.
3 to look at, 1 to fix first.
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
? image-optimizer-allowlist-wide could not be checked: this page resizes images through the Next.js image address, and whether that address fetches only the hosts you listed is not visible from the page; add settingsFiles to gaugeline.images.json (the images settings of your framework), or run the probe on a site you own (/_next/image)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 20 of 41 images.
6 to look at, 1 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/images.test.ts`.

### Other pages of the same site

The checks that compare or classify pages (such as `error-shell-200`, which is on by default) read a
sample of at most 4 other same-site pages, found from the links on the page you checked, each with one
`GET` and a body cap. The pages are fetched once and shared by every check that needs them. When the site
has more, the run prints "Checked 4 of 10 other pages." and the rest are not requested.

### A made-up address (a probing check)

With `--owner-consent` (or a `gaugeline.consent.json`), the `not-found-200` check asks the site for one
address that cannot exist, `/gaugeline-not-found-3f9c2a71` on the checked page's own origin, and reports
a site that answers 200 for it ([Error pages that answer 200](guides/error-pages.md)). **Run it only on
sites you own or have permission to test.** Without consent nothing is asked.

- One `GET`, once per run. No cookie, no `Authorization` header, no query, no `Referer`.
- At most 4,096 bytes of the answer are read, only for the status and where it leads; the body is not
  kept or printed.
- It goes through the same fetcher as every other request, so a private address is refused unless
  `--allow-private` is set. Never a `POST`.

### Routes the page metadata does not reach (a probing check)

With `--owner-consent` (or a `gaugeline.consent.json`) **and** a `gaugeline.hidden.json` with a section that
matches `/*` (the whole site is hidden), the `noindex-header-missing` check asks for the made-up address above
and for the routes you listed under `noindexRoutes` in that file (the editor studio, an API route, a file), to
see whether each sends `X-Robots-Tag: noindex` ([Routes your page metadata does not reach](guides/noindex-header.md)).
**Run it only on sites you own or have permission to test.** Gaugeline never picks a route of its own: a
route is asked only if you wrote it.

- One `GET` per address, once per run, at most 9. No cookie, no `Authorization` header, no query.
- At most 16 KiB of each answer are read, only for the status, the `X-Robots-Tag` header and a robots meta
  tag; the body is not kept or printed.
- It goes through the same fetcher as every other request, so a private address is refused unless
  `--allow-private` is set. Never a `POST`.

### The editor studio (a probing check)

With `--owner-consent` (or a `gaugeline.consent.json`) **and** a `gaugeline.studio.json` that names the studio's
route, the `studio-response-cacheable` check asks for that route, to see whether its answer says it must not
be stored ([Is the editor studio cached?](guides/studio-caching.md)). **Run it only on sites you own or have
permission to test.** Gaugeline never picks a route of its own: it will not ask for `/studio` unless you
wrote it.

- One `GET` per route, once per run, at most 4 (redirects are followed, as a browser would). No cookie, no
  `Authorization` header, no query.
- At most 4 KiB of each answer are read, only for the status and the `Cache-Control` header; the body is not
  kept or printed, and a header's value is never printed.
- It goes through the same fetcher as every other request, so a private address is refused unless
  `--allow-private` is set. Never a `POST`.

### AI routes (a probing check)

With `--owner-consent` (or a `gaugeline.consent.json`) **and** a `modelEndpoints` list in `gaugeline.ai.json`, the
`ai-endpoint-open` check asks each route you listed (a chat route, a model list) to see whether it answers with no
login or shows a provider's error text ([AI routes that answer anyone](guides/ai-endpoints.md)). **Run it only on
sites you own or have permission to test.** Gaugeline never picks a route of its own: a route is asked only if you
wrote it.

- One `GET` per route, once per run, at most 8. No cookie, no `Authorization` header, no query. Never a `POST`.
- At most 16 KiB of each answer are read, only to tell a list of models, a model's reply or an error from a plain
  refusal; the body is not kept or printed, and a finding carries a count or the names of fixed signs, never a
  model name, a message or part of a key.
- It goes through the same fetcher as every other request, so a private address is refused unless
  `--allow-private` is set.

### Image optimizers (a probing check)

With `--owner-consent` (or a `gaugeline.consent.json`) **and** an `imageOptimizerProbeUrl` in
`gaugeline.images.json`, the `image-optimizer-open` check asks your site's image address
(`/_next/image`, `/_vercel/image`, `/_ipx/`, `/_image` or `/.netlify/images`) to fetch one picture from the
address you chose, and reports it when it does ([Open image optimizers](guides/image-optimizers.md)).
**Run it only on sites you own or have permission to test.** Without consent, or without an address, nothing
is asked. The settings files you list in `gaugeline.images.json` are read as text with or without consent:
that part sends nothing.

What it sends, per optimizer the page uses:

- One `GET` to your own origin, at most 5 in a run, with the width and quality your page itself used and
  your chosen address in the query. No cookie, no `Authorization` header, no `Referer`. No retry.
- No redirect is followed. Gaugeline never chooses the address: it refuses one that is not `https`, is an IP
  address or a private name, is your own host, is a host your image addresses already use, or is a host in
  the settings files you gave.
- The cost to you: your server fetches your picture once, one small cache entry per optimizer, and a line in
  your access log.

What it reads: the status, the content type and at most 1,024 bytes of the body, to tell an image from a web
page, after which the connection is closed. The body is never stored, logged, printed or put in a report, and
neither is the query string of the address.

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

`gaugeline platform` with no flag is the one exception to "no request has a body". It reads the Supabase
project named in `gaugeline.platforms.json` through Supabase's own MCP server, in its read-only mode, and
its requests are `POST`s of a JSON-RPC message to one registered address (ADR-0006), through the fetcher
only: `initialize`, the initialized notice, `tools/list` and three read tools with fixed arguments. It
never calls a tool that can write, and the token goes in one header ([Supabase through its own MCP
server](sources/supabase-mcp.md#what-gaugeline-sends-and-what-it-keeps)).

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

### Handoff (gaugeline handoff)

`gaugeline handoff <address>` reads who holds each part of a client's site and writes a report
([Handoff](guides/handoff.md)). Every request is `GET` or `HEAD`, through the fetcher, and each key goes
in a request header to its own provider and nowhere else.

- **The domain's registry.** The same two `GET`s as [Renewals](guides/renewals.md#domain-registration):
  IANA's bootstrap file and the registry's public RDAP record. It keeps the registrar's name, the name
  servers and whether the registry hides the registrant: never the registrant's name or contact.
- **DNS, only with `--dns`.** The name servers of the domain, through the machine's resolver.
- **Vercel, only for a project you name and a token you set.** `GET https://api.vercel.com/v9/projects/<name>`,
  then, for a team, the team's name and its member list, or, for a personal account, `/v2/user`. It
  keeps each member's address (to compare, then masked), role and whether an invitation is pending.
- **Sanity, only for a project and a token you set.** `GET https://api.sanity.io/v2021-06-07/projects/<id>`
  and the members' profiles. It keeps each member's address, role and whether it is an API token.
- **Google Business Profile, only when `gaugeline.listings.json` names the location and the listings
  token is set.** One `GET` of the location's administrators.

Addresses read from a provider are compared with the ones in `gaugeline.handoff.json` and are then
masked to their first letter and their domain: the screen, the three files and every message show only
the masked form, and the JSON holds no full address, no token and no provider id. A token never reaches
a log, a finding or a report (every message passes the redactor), and nothing is created, invited,
removed or changed. Text from a provider (a team's name, a project's title) is escaped in the HTML and
the Markdown, with invisible characters written out. The report is written only into the folder you
name (inside the one you ran from), never over a file without `--force`, all three files or none.

### Hosting cost (gaugeline cost)

`gaugeline cost <address>` (and `--cost` on the page check) looks for what runs up a hosting bill
([Hosting cost](guides/hosting-cost.md)). Every request is `GET`, through the fetcher.

- **The site itself.** The page is asked for a second time a few seconds after the first, with no cookies
  and no login, and so is each page you list under `pages` in `gaugeline.cost.json` (up to ten, on the same
  site), twice each. The bodies are compared in memory and dropped; only the first differing word of each
  is kept, in a finding, and it is escaped like all text from a site. Nothing is submitted.
- **Vercel, only for a token you set.** One `GET https://api.vercel.com/v1/billing/charges` for the
  complete days before today (and `teamId` when you name a team), with the token in a request header to that
  host only. Read from the answer: each service's name, quantity, unit, cost and currency by day. The token
  is never put in an address, a log, a finding or a report.
- **Sanity.** Nothing is requested: its usage has no documented read API Gaugeline could confirm.

What it prints: paths, cache header values, usage figures and dates. It never buys, upgrades, renews, logs in
or changes anything.

### Backups (gaugeline backups)

`gaugeline backups <address>` (and `--backups` on the page check) reads when a client's content and
database were last backed up ([Backups](guides/backups.md)). Every request is `GET`, through the fetcher.

- **Supabase, only for a project you name and a token you set.** One
  `GET https://api.supabase.com/v1/projects/<ref>/database/backups`, with the token in a request header to
  that host only. Read from the answer: whether daily backups and point-in-time recovery are on, and each
  backup's status and time.
- **Sanity, only for a token you set.** One
  `GET https://api.sanity.io/v2021-06-07/projects/<id>/datasets/<name>/backups`, likewise. Read: each
  backup's time.
- **An export folder you name.** Nothing is requested. The folder on this computer is listed: each file's
  name, size and time. A file is never opened or read, a subfolder is not entered, and a link is not followed.

The tokens are never put in an address, a log, a finding or a report. Nothing starts a backup or an export,
restores anything, logs in or changes anything. File names from your folder are escaped like all text in a
report.

### Trackers on sensitive pages (--trackers)

`--trackers` on the page check lists the trackers on pages with a form or a path you list
([Trackers on sensitive pages](guides/trackers-on-sensitive-pages.md)). Every request is `GET`, through the
fetcher.

- **The page itself.** Nothing extra: the trackers are read from the HTML the page check already fetched
  (script addresses, inline scripts and noscript tags), by a fixed table of patterns. Nothing is run and no
  cookie is read.
- **A Tag Manager container, only for a page that counts.** One `GET https://www.googletagmanager.com/gtm.js?id=GTM-XXXX`
  per container the page loads (at most three), the same public file every visitor's browser downloads.
  It is read as text in memory and dropped; no key or cookie is sent.

What it prints: the kind of tracker, the id it carries (a public identifier in the page's own code), the
page's path and why the page counts. Never page text, a form field name or a form value, and never a verdict
on whether a tracker is allowed. Nothing is submitted and no one is logged in.

### Rendered pages (--renderer playwright)

`--renderer playwright` loads the page in a browser you installed, so the page's own scripts run
([Rendered pages](rendered-pages.md)). Off unless named. The browser runs on your machine and nothing about the
page goes to a Gaugeline service or any other place.

- **What is requested.** The page and what it loads, by `GET` and `HEAD` only, through the same transport the
  fetcher uses: a private, loopback, link-local or metadata address is refused unless you typed it and passed
  `--allow-private`, and every redirect is checked again at each hop.
- **What is never requested.** Anything but `GET` and `HEAD`, a form submission, a WebSocket, WebRTC and
  WebTransport (they send UDP outside the page's web requests, so the browser is started with WebRTC limited to
  a proxy that goes nowhere and the names are removed from the page), a window, and a `file:` or other non-web
  address.
- **Analytics, and what can still reach yours.** A request to a host on a fixed list of analytics,
  advertising and session replay services (Google Analytics and Tag Manager, Meta, LinkedIn, TikTok, Bing,
  Hotjar, Clarity, FullStory, Mixpanel, Segment, Plausible, Yandex Metrica, Cloudflare Web Analytics, Matomo
  and Piwik hosted, and others) is stopped and recorded, and so is a request to a small list of analytics files
  and endpoints on any address, such as `/gtm.js`, `/gtag/js`, `/_vercel/insights`, `/matomo.js`,
  `/piwik.js` and `/cdn-cgi/rum`. That list is not complete. Analytics a site runs from its own address under
  a name not on the list, or a tool not named, is not recognised: the page's own scripts can still make those
  requests to the site, as `GET` or `HEAD`, and a rendered run may then count as a visit. Gaugeline does not
  say a rendered run adds nothing to your numbers; filter its visits out if that matters.
- **What the browser holds.** A fresh context for every page with no cookie, storage, login or permission, and
  an environment with none of your keys. Nothing is clicked, typed or submitted.
- **What is kept.** The renderer hands back the address the page ended on, its status, its text and links, and
  each request's address without the query string, method, kind and outcome. Page text is cleaned and cut like
  every other page text.

### Speed from Google (--pagespeed)

`--pagespeed` on the page check asks Google's PageSpeed Insights about the key pages
([Speed](guides/pagespeed.md)). It is the one flag whose purpose is to send something to a company you did not
type, so it is off unless named and says so on stderr before the first request.

- **What is sent.** One `GET https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed` per page
  (the mobile run, the performance category), at most five pages per run: the page you typed and the first
  same-site pages of the run's sample. The `url` it carries is the page's origin and path, never its query
  string, fragment or user name. No other host, no `POST`, no cookie, no header of Gaugeline's but its user
  agent. Nothing about the page's content or about you.
- **Only public pages.** Nothing is sent with `--allow-private`. An address on your computer or a private
  network, an address written as numbers, a name with no dot, a name with a reserved or private-use ending (with
  or without a trailing dot), a name from a wildcard service such as `nip.io`, and a name that resolves to any
  private, loopback, link-local or metadata address (a failed lookup counts) are never sent. The check says
  could not check and why.
- **Only a path that is not a secret.** No path parameter goes out, and a path with a part that looks like a
  token, a reset, invite or session link, or an encoded query mark is not sent.
- **No key.** No key is read or sent, so none can reach an address, a log, a finding or a report. Without
  one Google's allowance is shared with every other keyless caller, and when it is used up the check says could
  not check.
- **What comes back is data.** Only numbers (shares of loads, a score, timings) and the address Google ended on
  are kept, the address cut and its invisible characters shown as escapes. Nothing Google wrote is carried
  into a finding. It is never run or followed.
- **Not the Chrome UX Report API.** Its only method for a record is a `POST`; the same figures arrive in the
  PageSpeed answer, so that host is not contacted (decision record 0015).
- **No secrets, no model.** The same answers give the same findings.

### Served libraries (--libraries)

`--libraries` on the page check lists the JavaScript libraries a page serves that a published advisory names
([Served libraries](guides/served-libraries.md)). Every request is `GET`, through the fetcher, which refuses
private, loopback, link-local and metadata addresses unless `--allow-private` is set.

- **The scripts the page names.** One `GET` per `script src` in the page's own HTML, on the site or on another
  host such as a CDN, at most 20 for one page, never an address the page does not name. Each file is read as
  text in memory, at most 2 MiB of it is searched (for another site's script the fetcher is told to stop there; a file of the
  site's own is asked for once, as the secret check asks for it) for a banner comment, a
  version shape and a file name, and it is dropped. It is never run, and no key or cookie is sent.
- **The advisories.** Read from a file in the package, not from another service: nothing about the site is
  sent to anyone to look them up.

What it prints: the library, its version, the script's address with no query string, and each advisory's id,
a short description and the version that fixes it. Never script text beyond the version string, and never a
verdict on whether the site is vulnerable. Nothing is submitted and no one is logged in.

### Published but not live (--published)

`--published` on the page check compares the items your content system says changed lately with their pages
([Published but not live](guides/published-not-live.md)). It adds no request to the content system beyond what
the adapters already make to list published items (ids, types, slugs, times and field fingerprints, never a
document), and then:

- **The live pages.** One `GET` of the address of each changed item, on the site being checked only (an address on
  another host is never asked for), at most 40 in a run, and one `GET` of each page the site's sitemap lists that
  fits an item address and that no published item has. Nothing is submitted, revalidated or purged.
- **What is kept.** The item's type and slug or id, the time it changed, the names of the fields that differ, and
  the page's `Age`, `Last-Modified`, `Cache-Control` and cache status headers. Never a field's text from the
  content system or from the page, and no key.

### What changed, and who changed it (gaugeline changes)

`gaugeline changes` and the run history behind it ([What changed, and who changed it](guides/what-changed.md)) keep a
small record of each page when a run uses `--since last`, in `.gaugeline/runs/` on your computer.

- **What is kept.** Per page: the title and first h1 (cut at 120 characters), the canonical address, a hash of the main
  content's text, the paths of the links in it, the structured-data type names and the script addresses. Per finding:
  the check, the path and the title. Never the page's text, never the evidence line. Runs older than 90 days are
  deleted (`retentionDays`).
- **What it asks.** Only when `gaugeline.changes.json` names them, and only with `GET`: Sanity's edit history of the
  document named for a page and the names of its editors, and the production deployments of a Vercel or Netlify
  project. Tokens come from the environment and are blanked from every message.
- **Personal data.** The one kind is an editor's name as the content system shows it. It is printed in the output of
  the command and never written to the runs store. Without a name, the output says "an editor"; an email address is
  never read into the output. Gaugeline never infers an author.

### The care-plan receipt (gaugeline receipt)

`gaugeline receipt` ([The care-plan receipt](guides/care-plan-receipt.md)) reads the run history in `.gaugeline/runs/`
described above and prints a month's summary of it. It keeps nothing new and writes no file. With `--coming-up` it
makes the requests `gaugeline renewals` makes, and only those: the registry's public RDAP server for the domain, and
one `HEAD` of each certificate host. It adds no field to the history, never sends the receipt anywhere, and holds no
key, header or page text: the titles in it are the finding titles the history already kept.

### WordPress (--wordpress)

`--wordpress` on the page check compares a WordPress site's versions with the current releases and asks whether the
site lists its users ([WordPress](integrations/wordpress.md)). It runs only on a page that shows WordPress, and
every request is `GET`, through the fetcher, with no key and nothing sent.

- **wordpress.org.** One `GET https://api.wordpress.org/core/version-check/1.7/`, and one `GET` of
  `plugins/info/1.2/` or `themes/info/1.2/` for each plugin or theme slug the page's own file addresses show, at
  most 15 of each in a run. The slug is the only thing about the site that leaves: a plugin or theme name, which
  is public in the page's HTML.
- **The site's REST API.** One `GET` of `/wp-json/wp/v2/users?per_page=100&_fields=id` on the page's own site (the
  `/?rest_route=` form if `/wp-json/` is not found), asking for the id alone. No name, slug or address is
  requested, and only how many users were listed is kept.

What it prints: the versions the page shows, the current releases, and the count. Never a user's name, and never
page text. Nothing is submitted, no one is logged in and no key is sent.

### Audit pack (gaugeline audit --pack)

`gaugeline audit <address> --pack` runs the default page check on a prospect's site and writes a proposal
pack ([Audit pack](guides/audit-pack.md)). Every request is `GET` or `HEAD`, through the fetcher, and
they are the page check's own: public pages, the files they link to, `robots.txt` and the sitemap. The
probing checks (non-public paths, a site's own keys) are off unless you pass `--owner-consent` or keep a
`gaugeline.consent.json` in the folder you run from, and the pack says whether they ran.

- **Nothing is sent.** The pack is two files, written only into the folder you name (inside the one you ran
  from), never over a file without `--force`, both files or neither.
- **No secrets, no full email addresses.** Text from the site is redacted like every finding, and an email
  address in it is masked to its first letter and its domain. A content system contributes names, counts
  and ids only.
- **The logo is not fetched.** `--brand-logo` (or `brand.logoUrl`) is an `https` address written into the
  HTML. Gaugeline does not request it; the browser that opens the file does.
- **No model.** The pack is made from templates. Prices and hours are only those in
  `gaugeline.services.json`.

### Migration completeness (gaugeline migration)

`gaugeline migration <new-address>` compares an old site's list of pages with a new site
([Migration completeness](guides/migration.md)). Every request is `GET`, through the fetcher, and there
are at most two for each of up to 500 pages: the page's path on the new site, and the same path on the old
site when you give `--old`.

- **The old site's list.** With `--old`, the WordPress REST API's public, documented list of published
  posts and pages (`/wp-json/wp/v2/posts` and `/wp-json/wp/v2/pages`, no key, no login, published status
  only), then the sitemap, then the links on the home page if there is no API. With `--old-file` nothing
  is requested for the list: the file is read from this computer.
- **Nothing private is asked for.** No `/wp-admin`, no login, no form, no draft, no path that is not in the
  public list. A password-protected page is could-not-check.
- **The list is data.** Titles and addresses in it are compared and printed as text. They are never run,
  followed as instructions or sent anywhere, and a title that reads like an instruction changes nothing.
- **No secrets, no model.** The checks are plain rules: the same two sites give the same findings.

### Advisory check (gaugeline advisory)

`gaugeline advisory <site> <advisory>` answers "is my client affected?" from outside
([Advisory check](guides/advisory.md)). Every request is `GET`, through the fetcher.

- **OSV.** For an advisory id, one `GET https://api.osv.dev/v1/vulns/<id>` (the public OSV database, no key,
  once per run). That is a request to a public API and not to the checked site. OSV's query endpoint takes a
  `POST`, which Gaugeline never sends, so there is no query or batch call: an id OSV does not list under that
  name is answered with the way to give the package and range yourself (`--package`). What comes back is
  data: it is clipped, its invisible characters shown as escapes, and never run or followed. With a package
  and range typed, OSV is not asked at all, and nothing about the site is sent to OSV in either case.
- **The site.** The home page, the same page on `www` or the bare domain, each hostname you give with
  `--host` (up to five) and up to three other subdomains the home page links to: one `GET` each. Only when the
  advisory needs them, the script files the home page names (a Next.js build's script for its version; the
  scripts the served libraries check reads), at most 2 MiB of each, read as text and never run.
- **DNS, only with `--dns`.** The name servers of each hostname.
- **Nothing else.** No path is guessed, no `/.env`, `/wp-admin` or `readme.txt`, no form, no login, and no
  request is built to trigger a flaw. A WordPress plugin's version comes from the file addresses already in
  the page.
- **No secrets, no model.** The same site and advisory give the same answer.

### Script and header baseline

The script and header checks ([Script and header baseline](guides/script-baseline.md)) make no request
of their own. They read the page the run already loaded.

- **Read.** The `src` of each script tag, whether it has an `integrity` attribute, and the response
  headers of the page itself. No script is downloaded and nothing is sent to a script's host.
- **Kept with `--since last`** in `.gaugeline/last-run/<host>.json`: the host and path of each
  third-party script (the query string is cut off), integrity present or not, and nine security
  headers as header name and directive lists. A nonce or a hash in a policy is kept as one marker, and
  the address after `report-uri` or `report-to` is not kept at all. A source or header value loses any
  query string, fragment or user name.
- **Never kept.** Page text, query strings, nonces, cookies, keys and every other header.
- **The known-bad list** is a data file in the package. It is read on this computer and nothing is
  looked up online.

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
  `image`, `sitemap`, `feed`, `script`, `extra-page`, `other` or `query`), the method (`GET` or
  `HEAD`; `POST` for a read-only query, ADR-0006), the status or the reason there was none, how long
  it took in milliseconds and, for a redirect, where it pointed. A read-only query row also has
  `allow`, the id of the allowlist entry that let it through; the body, the headers and the key are
  never saved. The file is schema 2; a file of schema 1 (no queries) is still read.
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
(`pk_live_`, `pk_test_`) are meant to be public and are not reported. A Contentful preview token is reported by kind and place only, with no character of it; a Contentful delivery token is public by design and is not reported.

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

### Sanity images (checks that read your dataset)

Three checks (`sanity-image-crop-ignored`, `sanity-image-alt-unrendered`, `sanity-image-heavy`) run only when `gaugeline.adapters.json` names `sanity`. For the Sanity images on the page they send `GET` requests of the query address, published content only, with `SANITY_TOKEN` (a Viewer token) in a header and never in an address: one for the `size` of the asset documents (40 uploads to a request) and one for the published documents that refer to the uploads (10 uploads to a request). At most 100 uploads of the page are read.

```text
GET https://<project>.api.sanity.io/v2021-10-21/data/query/<dataset>?query=*[_type == "sanity.imageAsset" && _id in ["image-<hash>-<width>x<height>-<format>", ...]]{_id,size}&perspective=published
GET https://<project>.api.sanity.io/v2021-10-21/data/query/<dataset>?query=*[_type != "sanity.imageAsset" && (references("image-...") || ...)][0...31]&perspective=published
```

The second answer holds whole documents, because an image value can sit at any depth. The reader looks through each one for the image values that point at the uploads and keeps only, in its own state, the crop numbers, the hotspot numbers and one of "text", "none" or "unknown" for the alt text: no text, no title and no other field is kept, printed or stored by the reader. The fetcher holds the raw answers in memory for the length of the run, as it does for every request, and they are never written to disk or logged; at most 30 documents of at most 5 MB in all are asked for in one request. The asset ids put into a query are rebuilt from the page's image addresses and tested against a strict pattern first. What the findings mean: [Sanity images](/docs/guides/sanity-images#the-checks-that-read-your-dataset).

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
