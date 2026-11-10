# Paid downloads and delivery

What happens between someone paying and someone receiving.

A digital product has three handovers: the payment, the file, and the email. Each one can fail quietly, and none of them shows up as an error.

## A file people pay for, on a public address

Asset stores are world-readable by design. That's fine for a brochure and a problem the day the file is something a customer bought. If a page sells something and links straight to an asset URL, it's flagged.

Two checks look at the same link. They read the page's HTML only, and they never request the file: the link on the page is the evidence. Fetching a file that is already public proves nothing more, and it would put a customer's paid product on the machine running the check.

| Check                 | Id                  | Level          | When                                                                                         |
| --------------------- | ------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| A paid file is public | `paid-file-public`  | Fix this first | The page shows a price and links straight to a file on a public asset store.                 |
| A file is public      | `asset-file-public` | Worth knowing  | The page links to such a file and shows no price, or the link says terms, privacy or policy. |

- **What counts as a file.** A link to a `pdf`, `zip`, `epub`, `mp3`, `mp4`, `docx` or `xlsx` on a public asset store: Sanity's file CDN (`cdn.sanity.io/files/...`), Amazon S3, Google Cloud Storage and Firebase Storage, Azure blob storage, Cloudflare R2 (`*.r2.dev`), DigitalOcean Spaces, Backblaze B2, Supabase public storage, Cloudinary uploads, Vercel Blob, UploadThing and Uploadcare. Images are left out, and so is a file on your own domain: that is a download route, which the next section looks at. The list of file types and stores is proposed, not taken from any one vendor's page.
- **What counts as a price.** A currency symbol or code next to a number in the text a visitor can read ("$48", "48 USD", or a pound, euro or rupee sign before or after a number), or an Offer with a price above zero in the page's structured data. A phone number, a year and "$0" are not prices.
- **What is printed.** The file's host and path, and the words of the link. The query string is dropped, because it may carry a signature.
- **A signed address passes.** A link with both a signature and an expiry (CloudFront's `Expires` and `Signature`, S3's `X-Amz-Expires` and `X-Amz-Signature`, Google's `X-Goog-Expires` and `X-Goog-Signature`, Azure's `se` and `sig`) is not a world-readable address, so it is not flagged. Gaugeline doesn't read the clock: it can't tell you the expiry has passed.
- **Terms and policies are low.** A price on the page and a `terms.pdf` in the footer of every page is normal. When the link's words are terms, privacy or policy, the finding is `asset-file-public`, not `paid-file-public`.
- **A sample next to a price is still flagged.** The finding shows the link's words, so you can tell a free sample from the product in a second.

### Example: a running coach's plan

Tideline Coaching is a one-person business on a Sanity and Next.js site. The home page sells a 7-day plan for $48. The "Download" link points at the PDF in Sanity's file CDN, the footer links the terms of sale from the same CDN, and "Buy now" is a div that a script turns into a checkout (more on that below). Each check that passed also prints a line, left out here.

<!-- fixture: paid-downloads -->

```sh title=Terminal
$ npx gaugeline tideline-coaching.example
```

```text title=Output
✗ A file people pay for is on a public address
    "Download the 7-day plan (PDF)" links to cdn.sanity.io/files/k3x9q2/production/7e1c5a0b9d3f4a6b8c2d-7-day-plan.pdf, a public asset address, and the page shows a price.
! Nothing on the page can be linked to buy
    The page shows a price and 1 buy button, and none can be linked to: "Buy now" (an element with a click handler).
· A downloadable file is on a public asset address
    Links to a downloadable file on a public asset address: "Terms of sale" (cdn.sanity.io/files/k3x9q2/production/c0ffee01234567890abc-terms-of-sale.pdf).
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

3 to look at, 1 to fix first.
```

The plan is on a public address: anyone who has it can read it from the page's source without paying. The terms PDF is also public and that is fine, so it is a note. Fix: serve the plan from a route that checks the purchase and hands back a short-lived signed link (the callout at the end of this page).

### Example: a taproom's menu

Marlin Street Taproom has a press page with its brochure and a food menu as PDFs in the CDN, and no prices on the page. That is one note listing both files, and nothing to fix today:

<!-- prettier-ignore -->
```html title=Press page
<h1>Press</h1>
<a href="https://cdn.sanity.io/files/m7t2d9/production/5b1e9c3d70a4f2e86c10-taproom-brochure.pdf">Download our brochure</a>
<a href="https://cdn.sanity.io/files/m7t2d9/production/e04a7d12b9c35f60a8d1-food-menu.pdf?dl=menu.pdf">Food menu</a>
```

```text title=Press page findings
asset-file-public: Links to downloadable files on public asset addresses: "Download our brochure" (cdn.sanity.io/files/m7t2d9/production/5b1e9c3d70a4f2e86c10-taproom-brochure.pdf), "Food menu" (cdn.sanity.io/files/m7t2d9/production/e04a7d12b9c35f60a8d1-food-menu.pdf).
```

The day the taproom sells a ticketed tasting pack as a PDF from the same place, the same page would be `paid-file-public`. The test `packages/core/src/checks/__tests__/paid-files-docs.test.ts` builds the page above and asserts these lines.

## A download route that hands the file to anyone

A customer download usually goes through a route on your own site: `/api/download/7-day-plan` checks that the visitor bought the plan, then hands back the PDF. If the route forgets the check, or the check has a gap, everyone with the address gets the file. Gaugeline asks the route for the file with no session and no purchase. A route that protects something should refuse, or send the visitor to sign in. If it returns the file, that is the finding.

The check is `gated-download-open` (Fix this first). It is a **probing** check: it asks a route that should be protected for what it protects, with no login. It is off unless you pass `--owner-consent` or add a `gaugeline.consent.json` ([how](options.md#probing-checks-owner-consent-and-routes)). **Run it only on sites you own or have permission to test.**

### Example: a coach's members page

Tideline Coaching's members page links to three download routes: the 7-day plan, a members guide and the beach class notes. The plan's route forgot its purchase check. The others do their job: one redirects a visitor with no session to `/login`, the other answers 401.

<!-- fixture: gated-downloads -->

```sh title=Terminal
$ npx gaugeline tideline-coaching.example --owner-consent
```

```text title=Output
✗ A download meant for customers is handed to anyone
    /api/download/7-day-plan -> 200 application/pdf. Asked with no session and no purchase, the route handed over the file.
· Links on this page go through a redirect
    /api/download/members-guide (302) ends at /login?next=/api/download/members-guide
? broken-links could not be checked: refused automated readers (401) (/api/download/class-notes)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 to look at, 1 to fix first.
```

The first finding is the one to fix: `/api/download/7-day-plan -> 200 application/pdf` says the route answered 200 with a PDF to a request that had no session. The other lines are other checks looking at the same links, left in so the output is the real one: the members guide link goes through a redirect (to the login page, which is what a gate does), and the link check lists the class notes as a link it was refused (401), which is what a gate does.

### How it finds the routes

- **From the links on the page.** A same-site link whose path contains `download`, `file`, `deliver` or `export`, or sits under `/api/`. A link straight to a file, such as `/files/menu.pdf`, is a static file and not a route: the checks in the first section cover files that are served as files. A link that carries its own signature and expiry is a signed link, not a gate, and is not asked.
- **From your repository, with `--routes <glob>`.** Run Gaugeline from the repository's folder, for example `--routes "app/api/**/route.ts"`. Each route file name becomes the address it serves: `app/api/download/[id]/route.ts` becomes `/api/download/[id]`, and `pages/api/export.ts` becomes `/api/export`. Only file names are read, never the files. A route whose path does not say download, file, deliver or export is never asked. This list is proposed, like the keywords for links.
- **A dynamic segment is asked only for an address a link gave.** `[id]` is asked for `/api/download/7-day-plan` because the page links to it. If no link gives it a concrete address, it is listed as not asked, and Gaugeline never guesses or counts through ids.
- **At most 10 routes per run**, the first ten in sorted order, so the same page gives the same ten every run. The others are named as skipped, so a route that was not tested is never silently a pass.

### What it sends and reads

One anonymous `GET` per route: no cookie, no `Authorization` header, no `Referer`, and not a protected preview's secret. It reads the status and the headers, then at most 1,024 bytes of the body, and closes the connection. The file is never downloaded, stored, logged or printed, and the query string of the address is never printed. The full list is on [Privacy and safety](privacy.md#download-routes-a-probing-check).

### What counts as handing the file over

| The route answered                                                            | Result                                                                                                                           |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 200, a file content type or `Content-Disposition: attachment`, and file bytes | **Finding.** The bytes are read: `%PDF`, `PK`, `ID3` and a few more.                                                             |
| 200 `text/html`, or any 200 whose first bytes are HTML ("please sign in")     | Pass. The bytes win over the header: an `application/octet-stream` page is a page.                                               |
| 401, 403, 404 or another refusal                                              | Pass.                                                                                                                            |
| A redirect to a login or sign-in address                                      | Pass. The login page is not asked for.                                                                                           |
| A redirect anywhere else, such as a signed storage address                    | Followed one hop. If that hands over the file, it is a finding, and it says the signed link was issued without a purchase check. |
| 429, a server error, no answer, or a second redirect                          | Could not check, with the reason. Never a pass.                                                                                  |

A route that streams an HTML error after a prefix that looks like a file could be misread, and the signature check makes that unlikely. The 1 KB limit, the cap of 10 routes, the path keywords and the `--routes` glob are proposed, not taken from any vendor's page.

### The fix

Check the purchase in the route, then hand back a short-lived signed link. A route that cannot tell who is asking should answer 401 or redirect to sign in, never return the file.

## Nothing on the page can be linked to buy

A price and a button with no address behind it means nobody can share a link to the purchase, search engines see no offer, and a script failure turns the page into a brochure.

The check is `checkout-js-only` (Fix soon). It fires when a page shows a price and has at least one buy button, and none of its buy buttons can be linked to:

- **A buy button** is a button or a link whose words are buy, add to cart (or bag, basket), checkout, get it, purchase or download now. The words are English, and a text over 60 characters is a paragraph, not a button.
- **It can be linked to** when it is an anchor with an address, or a submit button inside a form with an action. An anchor with `href="#"`, an empty `href` or a `javascript:` address counts as no address. A `div` or `span` with a click handler, a `role="button"` element and a button outside a form never can.
- **One is enough.** If any buy button on the page is linkable, or the page links to a hosted payment page (a Stripe payment link, a Square link, PayPal.me) anywhere, there is something to link to and nothing is flagged.
- **Without running scripts.** Gaugeline reads the page as a crawler gets it. A buy button drawn by JavaScript after the page loads isn't in the HTML, so it isn't seen, and that page isn't flagged either.

### Example: a beach class booking

Tideline Coaching also sells places in a Saturday beach class for $15. The "Add to cart" on the class page is a styled `div` that a script wires up to a checkout:

```html title=Class page
<h2>Beach class</h2>
<p>Saturday at low tide, six places. $15 a place.</p>
<div class="btn" onclick="openCheckout('beach-class')">Add to cart</div>
```

```text title=Class page findings
checkout-js-only: The page shows a price and 1 buy button, and none can be linked to: "Add to cart" (an element with a click handler).
```

Fix: make the button a link to your checkout or to a Stripe payment link, or a submit button in a form that posts to your cart, and let the script improve it from there. The test `packages/core/src/checks/__tests__/paid-files-docs.test.ts` builds the page above and asserts this line.

::: info
The fix is the same in every case: check the purchase in the route, then hand back a short-lived signed link. Never email the asset address.
:::

## Paid, and the receipt never went out

The third handover is the email. A customer pays, your site says "thanks", and a receipt with the download link is meant to follow. Your application's log says the send succeeded. That log records the attempt. The mail provider records what it accepted and sent, and that is the record worth comparing with the payments.

`gaugeline delivery --paid --sent` counts the orders paid in Stripe in a window, counts the emails Resend says it sent in the same window, and reports paid orders that have no email behind them. **It prints counts and days, never customer data.** It is read only: it never sends, resends or replays anything.

```sh
npx gaugeline delivery --paid --sent --since 7d
```

| Flag            | Does                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `--paid`        | Reads the orders paid in Stripe. Needs `STRIPE_API_KEY`.                                                   |
| `--sent`        | Reads the emails Resend lists as sent. Needs `RESEND_API_KEY`.                                             |
| `--since <win>` | The window: `7d` (the default), `24h`, or a date such as `2026-11-01` (midnight UTC). Up to 366 days back. |
| `--json`        | The result as JSON (schema 2) and nothing else. The counts are in `sampled` and in the finding's evidence. |
| `--ci`          | Exit 1 when the finding is found.                                                                          |

Either flag alone prints that side's count and compares nothing. A window that cannot be read, a key that is missing or refused, or a provider that does not answer is exit 2, with a sentence that names the variable.

### The two keys

Keys come from the environment only: no flag, config file or prompt takes one, and a key never reaches a log, a finding or a report. Every request is a `GET` with the key in an `Authorization` header and never in the address.

- **Stripe: `STRIPE_API_KEY`, a restricted key.** In the Stripe dashboard create a restricted key and set **Checkout Sessions**, **PaymentIntents** and **Charges** to Read, and everything else to None. Checkout Sessions lists the orders; PaymentIntents and Charges are only there so a session refunded in full is not counted as paid. A secret key (`sk_`) is refused with exit 2 unless you pass `--allow-secret-key`, which uses it with a notice. The permission names are from memory and uncited, because Stripe's documentation could not be reached when this was written: if the dashboard names them differently, the 403 message says what the key could not read.
- **Resend: `RESEND_API_KEY`.** The list of sent emails needs a key with full access; as far as we know Resend has no read-only key type, so this key can also send. Gaugeline only ever lists. Use a key made for this, and revoke it when you stop. This is uncited too.

### Example: a running coach's receipts

Tideline Coaching sells a 7-day plan through Stripe Checkout and sends the receipt and the download link through Resend from a Next.js route. Twelve people paid this week and nine receipts left. The route's log says "sent" every time.

```sh title=Terminal untested="Needs a Stripe account and a Resend account, which a docs runner must not use. packages/cli/src/__tests__/delivery-docs.test.ts runs this command against stand-ins for both (invented clients, no keys) and compares the output with the block below."
$ npx gaugeline delivery --paid --sent --since 7d
```

```text title=Output
Paid orders and sent emails, the last 7 days (2026-11-03 to 2026-11-10 UTC)
12 paid, 9 sent

2026-11-05  2 paid, 2 sent
2026-11-06  3 paid, 2 sent
2026-11-07  1 paid, 1 sent
2026-11-08  4 paid, 2 sent
2026-11-09  2 paid, 2 sent

✗ Orders were paid and no receipt went out
    12 paid, 9 sent in the last 7 days (2026-11-03 to 2026-11-10 UTC): 3 paid orders have no matching email. Paid is above sent on 2026-11-06 (3 paid, 2 sent), 2026-11-08 (4 paid, 2 sent). Orders and emails are matched by recipient, not by day.

1 to look at, 1 to fix first.
```

The count says there is a problem and the days say where to look: open Resend's dashboard on 6 and 8 November and compare its sends with the orders in Stripe. The three customers are not named on purpose. A list of people who did not get a receipt is personal data in a terminal's scrollback and in a CI log, and the count and the day are enough to find them in the two dashboards you already have.

Either flag alone is a count:

```sh title=Terminal untested="Same as above: packages/cli/src/__tests__/delivery-docs.test.ts runs it against the same stand-ins."
$ npx gaugeline delivery --paid --since 7d
```

```text title=Output
Paid orders, the last 7 days (2026-11-03 to 2026-11-10 UTC)
12 paid
```

### What counts

- **Paid.** A Checkout Session whose `payment_status` is `paid`, created inside the window, and not refunded in full. An unpaid session, a free one (`no_payment_required`) and a fully refunded one are not orders. A partial refund is still an order. Sessions are read newest first, 100 a page, up to 50 pages.
- **Sent.** An email Resend lists, created inside the window, unless its last event says it bounced, failed, was cancelled, is still queued or scheduled, or was suppressed: those did not reach anyone. Opened, clicked and delayed emails count. The list is read 100 a page, up to 50 pages, and only as far back as the window.
- **Days are UTC days.** An order at 23:59 and its email at 00:01 are on different days and still match: matching ignores the day.

### How the match is made

Each order takes one email addressed to the same recipient. In memory, a `Map` keyed by the SHA-256 of the lower-cased address counts the sent emails for each recipient, and each order takes one from its recipient's count. An order that finds the count at zero is unmatched.

- **One count per key, not a yes or a no.** A customer who bought twice needs two emails. A set of addresses would call the second order delivered because the first one was. Comparing the two totals alone hides an order with no email behind another that had two.
- **Hashes, not addresses.** The `Map` holds hashes only, lives inside one function call and is dropped when it returns. The result holds two counts, the unmatched count and the days.
- **More emails than orders is fine.** A resend, or a receipt for an order outside the window, is never a negative number: `unmatched` is the paid orders left without an email, and it stops at zero.
- **By recipient and window.** An email sent to a different address than the order's (a receipt sent to the account's address and not the payer's) shows as unmatched. So does an order with no address on it.

### The window that could be read

Stripe lists every session. Resend keeps sent emails for a limited time, which depends on the plan; Gaugeline assumes 30 days (proposed, uncited) and says so when the window you asked for reaches further back. When one side cannot be read as far back as you asked, or a page cap cut it short, both sides are cut to the same shorter window and a line on stderr says which:

```text title=stderr
Only 2026-11-07 to 2026-11-10 could be read on every side asked for, so that is the window compared; you asked for the last 7 days.
```

An order older than the emails Resend still holds would otherwise look like a receipt that never went out. If your plan keeps fewer days than the default assumes, keep `--since` inside it.

### The check

| Check                                    | Id                         | Level          | When                                                                      |
| ---------------------------------------- | -------------------------- | -------------- | ------------------------------------------------------------------------- |
| Orders were paid and no receipt went out | `delivery-receipt-missing` | Fix this first | At least one paid order in the window has no sent email to its recipient. |

The fix is in the mail code, not in Gaugeline: find why those sends failed or never happened (a sender address that is not verified, a catch block that logs and moves on, a queue that dropped the job), fix it, and send the missing receipts from Resend's dashboard. Gaugeline never resends.

## Webhooks that quietly stopped

Stripe tells your site about a payment by calling a webhook endpoint. When the endpoint is down, or answers with an error, the payment happened and your site was never told: no order is recorded, no file is released and no email is sent. Stripe retries for a few days and then stops.

`gaugeline platform --webhooks` reads the webhook endpoints on the Stripe account and the events that were not delivered, and reports two things. It reads delivery history only. **It never replays, retries, resends or enqueues anything** (see the Webhooks and queues row on [What it can and can't write](writes.md)).

```sh
npx gaugeline platform --webhooks
```

It needs `STRIPE_API_KEY`, a restricted key with **Webhook Endpoints** and **Events** set to Read and everything else None (from memory, uncited, like the permission names above). The key is handled as on the section before: the environment only, a header and never an address, and never printed. `--json`, `--ci` and `--allow-secret-key` work as they do for `delivery`.

### Example: a taproom's ticket sales

Marlin Street Taproom sells tickets to its tasting nights through Stripe Checkout, and the site's webhook route marks a ticket as sold. Six days ago a deploy broke that route. Stripe's list also still holds an endpoint for the old WordPress site, disabled.

```sh title=Terminal untested="Needs a Stripe account, which a docs runner must not use. packages/cli/src/__tests__/delivery-docs.test.ts runs this command against a stand-in for Stripe (invented endpoints and events, no key) and compares the output with the block below."
$ npx gaugeline platform --webhooks
```

```text title=Output
Stripe webhook endpoints: 2 (1 enabled, 1 disabled)
Events read: 2026-10-11 to 2026-11-10 UTC (Stripe keeps events for 30 days)

hooks.marlin-street-taproom.example     enabled, 14 events not delivered, the oldest 6 days old
old-site.marlin-street-taproom.example  disabled

✗ A webhook endpoint is not receiving its events
    hooks.marlin-street-taproom.example: 14 events older than 1 hour not delivered, the oldest 6 days old.
! A webhook endpoint is switched off
    old-site.marlin-street-taproom.example is disabled, so Stripe sends it no events.

2 to look at, 1 to fix first.
```

Only the host is printed. A webhook address often carries a secret in its path or its query, and that never leaves the Stripe response.

### The checks

| Check                                      | Id                 | Level          | When                                                                                          |
| ------------------------------------------ | ------------------ | -------------- | --------------------------------------------------------------------------------------------- |
| A webhook endpoint is not receiving events | `webhook-failing`  | Fix this first | An enabled endpoint has events older than 1 hour that were never delivered. Host, count, age. |
| A webhook endpoint is switched off         | `webhook-disabled` | Fix soon       | An endpoint's status is disabled.                                                             |

- **An hour is the threshold.** A delivery that is still being retried a few minutes after an event is normal, so an event counts only when it is more than an hour old and still has deliveries pending. The hour is proposed.
- **Events are read for 30 days.** That is as far back as Stripe keeps them (uncited), and the output states the first day that was read. An endpoint that has been failing for longer shows the last 30 days of it.
- **An event is counted against every endpoint that takes its type.** Stripe's list says an event is undelivered, not which endpoint it was waiting for. An endpoint that takes everything (`*`) or the event's type is told about it, so two endpoints that take the same type each show it, and the count is an upper bound. A disabled endpoint is given no count: Stripe sends it nothing.
- **The fix is in Stripe and in your route.** Open the endpoint in the dashboard, read what it answered, fix the route, then let Stripe retry or resend from there. Gaugeline never does.
