# Script and header baseline: what loads on a payment page, and what changed

A booking or checkout page runs other people's code. The card form, the analytics tag and the chat
widget each load a script from a host you don't control, and each can read what a customer types.
The page looks the same on the day one of them changes, or a deploy quietly drops a security header.

Gaugeline writes down which third-party scripts a page loads and which security headers it sends,
and with `--since last` tells you what is different on the next run. It reports the change and says
nothing about whether it was wrong. This is the same idea as the change detector that PCI DSS 11.6.1
describes for payment pages: know what loads, and notice a change. It does not make a site
compliant, and it does not replace a review.

It is read only. Every request is a `GET` of the page itself, and no script is downloaded: the
addresses are read from the page's HTML. Nothing is sent to any script's host.

## What the baseline holds

Saved in `.gaugeline/last-run/<host>.json` by `--since last`, for the page you checked:

| Part                | What is kept                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Third-party scripts | The host and path of each (no query string), and whether its tag has an `integrity` attribute          |
| Security headers    | Which of nine headers the page sent, with their directives: `script-src` and its list of sources       |
| Never kept          | Page text, query strings, nonces and hashes (one marker stands for both), cookies, keys, other headers |

The nine headers are `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` and the three `Cross-Origin-` policies
(opener, embedder, resource). A script is third party when its host is outside the page's own
registrable domain, so `static.yourclinic.example` is the clinic's own and `js.stripe.example` is not.
A page keeps at most 200 scripts, 100 directives and 500 sources in a directive; past a limit the
run says "could not be checked" and names it, so a cut is never silent.

## The checks

| Check                      | Level          | When                                                                                  |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `script-known-bad-host`    | Fix this first | A script comes from a host on the known-bad list. On every run                        |
| `csp-loosened`             | Fix this first | The policy is gone, a directive is gone, or a directive now lists a source it did not |
| `script-changed`           | Fix soon       | A third-party script is new, or one that had an `integrity` attribute has lost it     |
| `security-header-loosened` | Fix soon       | One of the other headers is gone, or sends less protection                            |

- The last three run with `--since last`. On the first run nothing is saved yet: each is "could not be
  checked", and that run saves the baseline. Without `--since last` they have nothing to compare.
- Only a change toward allowing more is reported. A script that went away, a header that appeared, a
  policy that got stricter and a nonce that changed on every request are not changes.
- `csp-loosened` compares what each directive allows once its fallbacks are applied
  (`script-src-elem`, then `script-src`, then `default-src`; `frame-src` then `child-src`; and so on).
  A directive added or removed is a change only if the policy as a whole allows more: a new
  `script-src-elem 'unsafe-inline'` is, and removing a `script-src` that `default-src` repeats is not.
- It is high when `'unsafe-inline'`, `'unsafe-eval'`, `*`, `data:`, `https:` or `http:` is added to
  `default-src` or a script directive, or when a script directive is gone and nothing covers it. Any
  other added source is medium.
- Sources are compared as sources. `'none'` allows nothing. A host under a wildcard
  (`https://*.example.com` to `https://cdn.example.com`), a scheme added to a host that had none
  (`example.com` to `https://example.com`), a path under a path and a listed host where there was `*`
  or `https:` are narrowing. A new host, a wider wildcard, a new port, a shorter path or a new scheme is
  looser. `'unsafe-inline'` beside a nonce or a hash is ignored by browsers and is not counted, but a
  policy that drops its nonce and keeps `'unsafe-inline'` now allows inline code.
- The address after `report-uri` and `report-to` is never saved (it often carries a key): only that the
  directive is set.
- A response with more than one policy keeps the first as written and names the others `script-src#2`,
  so dropping a second policy shows as its directives going.
- `Strict-Transport-Security` is loosened by a smaller `max-age` or a dropped `includeSubDomains` or
  `preload`; `X-Content-Type-Options` by no longer being `nosniff`; `X-Frame-Options`,
  `Referrer-Policy` and the `Cross-Origin-` policies by a less strict value; `Permissions-Policy` by
  a feature removed or given a new origin.

### Limits

- The headers are those of the page's own response. A policy set in a `<meta http-equiv>` tag and
  `Content-Security-Policy-Report-Only` are not read.
- One page per run: the address you give. A script a tag manager loads after the page runs is not in
  the HTML, so it is not in the baseline.
- `--since last` saves this run in place of the last, so a change is reported once. Run it on a
  schedule and use `--ci` to be told on the day it happens; keep the first run's file if you want one
  fixed reference.

## The known-bad list

`script-known-bad-host` reads `packages/core/src/data/known-bad-script-hosts.json`. Each entry is a
host, the month its source dates the problem from, a one-sentence note and the source (title and
address). A host matches itself and its subdomains. The list starts with `polyfill.io`, whose scripts
were reported in June 2024 to send some visitors to unrelated sites.

Every entry is marked `"proposed": true` for now: it was written from a recollection of its source and
has not been confirmed by a maintainer, and the finding says so. A host is added with its source in a pull request, and
a test checks every entry names one. The list says what a named report says. It is not a judgement of
any company, and a host that is missing from it is not safe.

## Example: a physio clinic's booking page

Harbour Street Physio is an invented clinic whose freelancer built its booking page. The card form
loads from `js.stripe.example`, with an integrity attribute, and the page sends a strict policy
(`packages/fixtures/sites/checkout-before` and `checkout-after`; a test runs both and compares the
output below).

### The first run

Checked with `gaugeline harbourphysio.example --since last`, which saves the baseline:

```text title=Output
? csp-loosened could not be checked: no saved scripts and headers to compare with yet: this run saves them (/)
? nav-changed could not be checked: no saved menu to compare with yet: this run saves one (/)
? page-gone could not be checked: no saved pages to compare with yet: this run saves them (/)
? page-lost-content could not be checked: no saved pages to compare with yet: this run saves them (/)
? page-lost-items could not be checked: no saved pages to compare with yet: this run saves them (/)
? page-lost-structured-data could not be checked: no saved pages to compare with yet: this run saves them (/)
? script-changed could not be checked: no saved scripts and headers to compare with yet: this run saves them (/)
? security-header-loosened could not be checked: no saved scripts and headers to compare with yet: this run saves them (/)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Nothing to look at.
```

### The next run

A month later a developer adds a chat widget, a compatibility script from `polyfill.io`, and
`'unsafe-inline'` to the policy so both work, and a hosting change drops
`Strict-Transport-Security`. The same command prints:

```text title=Output
✗ The Content-Security-Policy allows more than it did
    content-security-policy: script-src now allows 'unsafe-inline' https://widget.chatreply.example https://cdn.polyfill.io; last run it was 'self' https://js.stripe.example https://tags.analytics.example
✗ A script comes from a host on the known-bad list
    cdn.polyfill.io/v3/polyfill.min.js: polyfill.io is on the list of hosts to avoid since 2024-06. Sold in February 2024; in June 2024 researchers reported its scripts sending some visitors to unrelated sites. Source: Sansec: Polyfill supply chain attack hits 100K+ sites (https://sansec.io/research/polyfill-supply-chain-attack). This entry has not been confirmed by a maintainer
! A third-party script is new, or lost its integrity attribute
    widget.chatreply.example/loader.js is new since the last run (no integrity attribute)
! A third-party script is new, or lost its integrity attribute
    cdn.polyfill.io/v3/polyfill.min.js is new since the last run (no integrity attribute)
! A security header sends less protection than before
    strict-transport-security is no longer sent; last run it was max-age=63072000; includesubdomains
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

5 to look at, 2 to fix first.
```

Nothing on the page looks different to a patient. The report says what changed: two scripts that were
not there, a policy that now lets inline code run, one script host a published report names, and a
header that is gone.

## In CI

Run it on the booking page weekly and keep `.gaugeline/` between runs with your CI's cache:

```bash
npx gaugeline https://yourclinic.example/book --since last --ci
```

`--ci` exits 1 on a high finding. On a cache that was cleared the run is a first run again: the three
change checks are could not check, and `script-known-bad-host` still runs.

## What it reads

See [Privacy](../privacy.md#script-and-header-baseline) for exactly what is requested and kept.
