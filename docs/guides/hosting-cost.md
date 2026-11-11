# Hosting cost: find what runs up the bill

A Next.js and Sanity site can quietly multiply its hosting bill: a page that stops being cached, a loop
that asks for the same image again and again, a clock printed into the HTML. The client sees the invoice
a month late and blames the person who built the site. `gaugeline cost` looks for the likeliest causes
without any account access, and, if you give it a read key, tells you when a usage figure jumps, days
before the bill does.

It only looks. It never buys, upgrades, renews or changes a plan, and the only requests are `GET`.

```sh
npx gaugeline cost marlowe-bar.com
```

## What it reads

| What                         | How                                                                                                                             | Needs a key?   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Whether a page changes       | The page visited twice, a few seconds apart, with no cookies. The two bodies are compared once nonces and CSRF values are gone  | No             |
| Whether a page is cached     | The cache headers of those two visits: `x-vercel-cache`, `cf-cache-status`, `age`, and `Cache-Control`. Only for pages you mark | No             |
| Hosting usage                | One `GET` of the provider's usage figures, only for a key you put in the environment. Vercel first                              | The key itself |
| Whether the plan has a price | Sites on Wix, Squarespace, Webflow or Framer have a fixed plan, so usage is "not applicable", and the page checks still run     | No             |

Anything that is not exposed is listed as "could not be checked", with the reason. Gaugeline does not
guess, and it never reads a provider's dashboard page.

## Example: a bar whose specials page prints the time

Marlowe Bar is an invented client: a bar whose site you built on Next.js and Sanity and host on Vercel. Its
home page, menu and events page should be built once and served from the CDN. The specials page prints
when it was made. You keep a list of the pages that should be cached in `gaugeline.cost.json`, and a
Vercel token for the team in the environment of the machine that runs the check (the token is yours, not
the client's).

```json title=gaugeline.cost.json
{
  "static": ["/", "/menu", "/events"],
  "pages": ["/specials", "/menu", "/events"],
  "vercel": { "teamId": "team_harbour01" }
}
```

```sh title=Terminal untested="Runs the built command against recorded responses for an invented bar. packages/cli/src/__tests__/cost-docs.test.ts runs it (the docs runner points commands at a fixture site, and this one reads a usage API) and compares the output with the block below."
$ npx gaugeline cost marlowe-bar.example
```

```text title=Output
Hosting cost for marlowe-bar.example
Pages, likeliest cause of cost first
  /specials  This page changes on every visit because it prints the current time; caching can't help it.
  /events    This page is marked static but it is never served from the CDN's cache, so the host builds it again for every visitor.
  /menu      This page is marked static, but its cache lifetime is 1 second, so the host rebuilds it about every second instead of keeping the last copy.
  Fine: /
Account usage
  Vercel: Billed cost was 2.1 USD on 10 Nov 2026, 3.4 times its average of 0.6 USD over the 14 days before
  Vercel: Fast Data Transfer was 41 GB on 10 Nov 2026, 3.4 times its average of 12 GB over the 14 days before
  Sanity: could not check: SANITY_TOKEN is not set, so Sanity was not asked

! The page's HTML is different on every request
    Two visits 3 seconds apart gave different HTML after "<h1>Tonight's specials</h1><p>Updated": "2026-11-11T09:00:03Z" the first time, "2026-11-11T09:00:08Z" the second (it looks like a time)
! Hosting usage jumped
    Vercel Billed cost was 2.1 USD on 10 Nov 2026, 3.4 times its average of 0.6 USD over the 14 days before (flagged above 2 times)
! Hosting usage jumped
    Vercel Fast Data Transfer was 41 GB on 10 Nov 2026, 3.4 times its average of 12 GB over the 14 days before (flagged above 2 times)
· A page marked static is never served from the CDN's cache
    /events is marked static, and x-vercel-cache: MISS on both visits, 3 seconds apart: a cached page would have been a hit the second time
· A page marked static is rebuilt too often
    /menu is marked static and sends Cache-Control with s-maxage=1, a lifetime under the minimum of 60 seconds

5 to look at, none to fix first.
```

The list at the top is the summary: the pages that likely cost money, the likeliest cause first, then
what the account's usage says. Below it are the findings, each with why it matters and how to fix it in the
report. Here:

- The specials page prints the time it was built, so every visit is a new page and caching cannot help.
  It also explains the jump: Fast Data Transfer went from about 12 GB a day to 41 GB on 10 November,
  the day the page went live. Print the time in the browser instead, or leave it out.
- The events page is marked static and was a miss on both visits, so the host builds it again for each
  visitor. Look for what opts it out of the cache (a cookie it reads, a `no-store` fetch).
- The menu has a lifetime of one second, which means it is rebuilt about as often as it is visited. A menu
  that changes once a week can keep a copy for an hour.
- The home page differs on every visit only by a nonce, which Gaugeline ignores, and it was a hit the
  second time, so it is fine.
- Sanity's usage is "could not check". See [Keys](#keys-and-the-narrowest-one) below.

## Example: a pop-up on Wix

Ember Pop-up Kitchen is an invented pop-up dinner on a Wix site. Wix charges one plan price, so there is no
usage to watch: Gaugeline says that, and does not call it a failure to read. The page checks still run,
because a page that is rebuilt on every visit is slow as well as costly. With no settings file it judges
the address you gave and nothing is marked static.

```sh title=Terminal untested="Same as above: packages/cli/src/__tests__/cost-docs.test.ts runs it against the invented pop-up."
$ npx gaugeline cost ember-popup.example
```

```text title=Output
Hosting cost for ember-popup.example
Pages, likeliest cause of cost first
  /  This page changes on every visit because it prints a number that changes on every visit (a counter); caching can't help it.
  Caching was not judged: no page is marked static in gaugeline.cost.json (for example "static": ["/", "/menu"]).
Account usage
  Not applicable: fixed plan. Wix charges one plan price, so there is no usage to watch. The page checks above still apply: a page that rebuilds on every visit is slow as well.

! The page's HTML is different on every request
    Two visits 3 seconds apart gave different HTML after "</h1><p>Seats left tonight:": "14" the first time, "13" the second (it looks like a counter)
? never-cached could not be checked: no page is marked static in gaugeline.cost.json (for example "static": ["/", "/menu"]), so Gaugeline cannot tell which pages should be served from a cache (/)
? revalidate-too-often could not be checked: no page is marked static in gaugeline.cost.json (for example "static": ["/", "/menu"]), so Gaugeline cannot tell which pages should be served from a cache (/)

1 to look at, none to fix first.
```

The seat counter is real content, so here the answer may be that the page has to be live. Then the cost
is the price of showing it, and the fix is to load just the number in the browser. The two caching checks
are "could not be checked" until you say which pages should be cached.

## The checks

| Check                          | Severity      | What it says                                                                                         |
| ------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------- |
| `output-changes-every-request` | Fix soon      | Two visits a few seconds apart give different HTML, once nonces and CSRF values are ignored          |
| `never-cached`                 | Worth knowing | A page you marked static missed the CDN's cache on both visits                                       |
| `revalidate-too-often`         | Worth knowing | A page you marked static sends a cache lifetime under your minimum (60 seconds unless you change it) |
| `usage-jump`                   | Fix soon      | A usage figure for yesterday is more than a set multiple of its average over the days before         |

`never-cached` and `revalidate-too-often` judge only the pages you list under `static`, because only you
know which pages should be the same for everyone. When a lifetime of a second or more explains the misses,
only `revalidate-too-often` is reported; a lifetime of nothing (`no-store`, `private`) is reported as
`never-cached`. A `max-age` with no `s-maxage` is the browser's lifetime, not the CDN's: a page the CDN
served as a hit is fine, because Vercel and Cloudflare keep it until the next deploy or purge.

Values that are new on every visit and mean nothing are removed before the two visits are compared, by a
fixed table: `nonce` attributes and `'nonce-...'` sources, the value of a `csrf-token` meta tag and of a
hidden CSRF field (`authenticity_token`, `csrfmiddlewaretoken`, `__RequestVerificationToken` and the
like), and Cloudflare's scrambled email addresses. Everything else counts, so a real change shows. The
finding quotes the first differing word in each body, and says whether it looks like a time, an id or a
counter.

Both visits are sent with no cookies, so a variant that a cookie chooses is the one a first-time visitor
gets. A cookie whose name looks like an experiment (`ab_variant`, `bucket`) is named in the evidence: a
variant picked at random shows up as a change, and that is a cost too.

**Two visits can land on two servers.** A CDN has many edges, and a page can be a miss on the first and a
hit on the next. Run it again before you act on a `never-cached` finding.

## Keys, and the narrowest one

| Variable                 | Asked                                                                           | What is read                                                                       |
| ------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GAUGELINE_VERCEL_TOKEN` | `GET https://api.vercel.com/v1/billing/charges?from=<day>&to=<today>[&teamId=]` | For each service and day: the quantity, its unit, the billed cost and its currency |
| `SANITY_TOKEN`           | Nothing                                                                         | Nothing: Sanity's usage has no documented read API Gaugeline could confirm         |

The token goes in a request header to that host only, and is never printed, logged or put in a result.

**Vercel has no read-only token type**: a token acts as the account that made it. Make one on a team member
with the narrowest role you have, scoped to the one team, with an expiry, and treat it as a key to that
team. If you would rather not hold one, leave `GAUGELINE_VERCEL_TOKEN` unset: the page checks need no key.
(This is the same token `gaugeline renewals` and `gaugeline handoff` read.)

**Sanity** shows its usage in the management dashboard. Gaugeline could not confirm a documented HTTP
endpoint that returns it with a read-only token, so it does not ask, it never reads a dashboard page, and
the line says so. When Sanity documents one, it will be read with the Viewer role.

The Vercel endpoint and its field names (`ServiceName`, `ConsumedQuantity`, `ConsumedUnit`, `BilledCost`,
`BillingCurrency`, `ChargePeriodStart`) were written from memory: Vercel's documentation could not be
reached when this page was written, and none of its text is quoted. If an answer differs, Vercel's
reference is right and this page is not; an answer in any other shape is "could not be checked", and a
404 or a refusal is reported with its status, never guessed around.

## How a jump is found

Each service and its unit is a metric, and the billed cost is one more. The figures are added by UTC day
and kept as whole thousandths, so every sum and comparison is exact and the same on every machine. The
latest complete day (yesterday, UTC, by the run's clock) is compared with the average of the days before
it, 14 by default. It is a jump when it is **more than** twice that average. Days with no row count as
zero; a metric with no usage in those days has nothing to be a multiple of and is skipped, and so is a
latest day under one whole unit. Today is never read, because it is not over.

## In the nightly run

`--cost` adds these checks to any page check, so they join the nightly run, and
`gaugeline run --all --cost` does it for every site in `gaugeline.sites.json`. Each run waits about three
seconds between the two visits, so it adds that to a site's time, not to the other sites'. The tokens come
from secrets, by site prefix like the other keys ([Many sites](many-sites.md)).

## Settings

`gaugeline.cost.json`, read from the folder you run from. Every field is optional.

| Field            | What it does                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `static`         | Pages that should be served from a cache: paths, or a folder with a trailing star (`"/blog/*"`), up to 50  |
| `pages`          | Other pages to visit twice besides the one you gave: paths on the same site, up to 10                      |
| `minimumSeconds` | The shortest cache lifetime a page marked static may have. Default 60                                      |
| `vercel.teamId`  | The Vercel team whose usage is read (`team_` and letters or digits); leave out for the token's own account |
| `usage.window`   | Days before the latest one that make the average, 3 to 60. Default 14                                      |
| `usage.multiple` | A day more than this many times its average is a jump, above 1, two decimals at most. Default 2            |

## Options

| Flag                         | What it does                                                          |
| ---------------------------- | --------------------------------------------------------------------- |
| `--ci`                       | Exit 1 when a fix-first finding is found. These checks are never that |
| `--json`                     | Print the schema 2 result and nothing else                            |
| `--allow-private`            | Check a site on this computer or a private network                    |
| `--cost` (on the page check) | Add these checks to the page check and the nightly run                |

## What it does not do

- It does not buy, upgrade, downgrade or cancel anything, and it never logs in or opens a dashboard.
- It does not know your plan's limits: it compares a day with that account's own recent average, which is
  what a bill follows. A figure that is high but steady is not a finding.
- It does not read Sanity's usage (see above), and it does not read an account whose provider documents
  no read endpoint. Those are listed as "could not be checked", never as fine.
- It does not guess which pages should be cached. You list them.

What is requested, and from where, is on [Privacy and safety](../privacy.md#hosting-cost-gaugeline-cost).
