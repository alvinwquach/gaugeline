# Speed: what real visitors measured, and what a lab test says

A page can feel slow to the people who use it while a test says it is fine, or score badly in a test and be
fine for everyone. Gaugeline keeps the two apart. `--pagespeed` asks Google's PageSpeed Insights about the
key pages of a site and reports two things, separately:

- **Real visitors.** What Chrome measured on the visitors' own phones and computers: Largest Contentful
  Paint (how fast the main thing appears), Interaction to Next Paint (how fast the page answers a tap) and
  Cumulative Layout Shift (how much the page jumps), each at the 75th percentile. **This decides.** A vital
  that is not good is a finding.
- **A lab test.** One Lighthouse load on a simulated mid-range phone, run on Google's servers. **This is
  advice.** It never passes or fails a page, and its finding is the lowest severity there is.

It is off unless you ask for it, and it is read-only.

```sh
npx gaugeline pantry.example --pagespeed
```

## What leaves your machine

This is the one flag whose job is to send something to a company you did not type. Read this before you use it.

- **The address of each page it reads**, without its query string, its fragment or any user name, to
  `pagespeedonline.googleapis.com`. At most five pages per run: the page you typed, then the first same-site
  pages Gaugeline sampled. Nothing else is sent, and nothing about your site's content.
- **Only public pages.** Google reads the public web. Nothing is sent when the run has `--allow-private`.
  An address on your computer or a private network, an address written as numbers, a name with no dot, a
  name with a reserved or private-use ending (`.local`, `.internal`, `.test`, `.example`, `.home.arpa`,
  `.staging` and the like, with or without a trailing dot), a name from a service that turns any name into the
  address written in it (`nip.io`, `sslip.io`) and a name that resolves, on this computer, to any private,
  loopback, link-local or metadata address are never sent. If the name cannot be looked up, it is not sent.
  The check says could not check, and says why. A staging site behind a login cannot be read either.
- **Only a plain page address.** A path goes out only when it is the root, or has at most 6 parts and 120
  characters and every part is a short number (up to 4 digits: a year, a page number) or a lowercase slug of
  whole words: at most 30 characters, no word over 20, each word all letters or all digits (a word that mixes
  them is a code), at most 4 digits in the slug and 8 in the whole path, letters and digits never alternating,
  and no secret-looking word (`token`, `key`, `secret`, `reset`, `invite`, `session`, `password`, `verify`,
  `otp`, `unsubscribe`, and the whole words `magic`, `link`, `share`, `sig`, `signature`, `hmac`, `confirm`,
  `activate`, `access`, `code`, `pin`, `hash`, `bearer`, `credential`). A slug shaped like an email address
  (`...-at-...-com`) is not sent. The root and `/menu`, `/about-us/`, `/contact`, `/shop/summer-collection`,
  `/blog/2024/11/13` and `/blog/new-opening` are sent; `/user-12345`, `/jdoe-1985-03-12`, a long mixed
  token or a path with a capital letter, a dot, an underscore or an encoded character are not. Anything not
  plain fails closed: the page is could not check, "this page's address does not look like a plain public page
  address, so it was not sent", and nothing was asked of Google.
- **What no rule can see.** A person's name or other detail written as a page-name slug (`/team/ana-garcia`)
  cannot be detected by any rule. That is why `--pagespeed` is opt-in and tells you, before the first request,
  that page addresses are sent.
- **One call at a time.** Google's answers are slow, so the calls go one after another and never fill every slot
  the run's own requests to your site need.
- **One `GET` each, to one host.** Never a `POST`, never another host. Gaugeline says so on stderr before the
  first request. The host is on the registered list in decision record 0015 (`docs/adr/0015-pagespeed-and-crux.md` in the repository).

## No key

Gaugeline sends no key to Google: not in the address, not in a header, and it does not read one from your
environment. The API works without one, but the allowance is shared with every other caller without a key, and
Google answers "quota used up" (HTTP 429) when it runs out. That happens: a real call made while this page was
written got exactly that answer. The check then says **could not check** with the reason, and the run
finishes. It is never a pass and Gaugeline does not retry. Adding a key waits for Google's own pages to
confirm where a key may go that is not the address (decision 53), and is a small change after that.

## How the real-visitor figures decide

PageSpeed Insights hands back the Chrome UX Report's figures for the page, or for the whole site when the page
has too few visitors (Gaugeline says "the whole site's visitors" when that happens). For each vital Google
gives the share of loads in three buckets: good, needs improvement and poor. Gaugeline reads the buckets:

| Vital                     | Good is | Poor is     | The vital is good when          | It is poor when                 |
| ------------------------- | ------- | ----------- | ------------------------------- | ------------------------------- |
| Largest Contentful Paint  | 2.5 s   | over 4 s    | 75% of loads are 2.5 s or less  | over 25% of loads take over 4 s |
| Interaction to Next Paint | 200 ms  | over 500 ms | 75% of loads are 200 ms or less | over 25% are over 500 ms        |
| Cumulative Layout Shift   | 0.1     | over 0.25   | 75% of loads are 0.1 or less    | over 25% are worse than 0.25    |

"Good at the 75th percentile" and "at least 75% of loads in the good bucket" are the same statement, so the
shares are enough. Gaugeline does not use the `percentile` number in the answer: Google's reference describes
it as the 90th percentile for this version of the API, not the 75th. Between good and poor a vital "needs
improvement" (low). Poor is medium.

The shares are whole thousandths inside Gaugeline (750 is 75.0%), so "at least 75%" has no rounding edge.

## What it cannot say

Where Gaugeline cannot tell, it says **could not check**, never a pass:

- The page has no real-user figures at all (usually because too few people visit it).
- Google does not report one of the three vitals for the page. The others are still judged.
- A vital's buckets are not the good and poor limits above (the answer is in a shape Gaugeline does not know).
- The quota is used up, Google did not answer in time or could not be reached, it could not load the page
  (HTTP 400), or the answer was not a result.
- The page is not public, or the run found more than five pages (the rest are counted).
- Google's lab run failed for a page: the real-visitor figures are still used.

Real-user figures gather over weeks and move slowly: judge a fix after a few weeks of visits, not the day you
ship it.

## Example: Corner Pantry

Corner Pantry is an invented shop. Its home page loads its main picture slowly: 62% of real loads are 2.5
seconds or faster, 75% are needed. The shop's layout is steady and it answers taps quickly. A simulated phone
scores it 42 out of 100.

```text title="Terminal" untested="Needs Google's PageSpeed Insights, which a test must not call (the shared keyless quota is used up and a docs build has no network). packages/cli/src/__tests__/pagespeed-docs.test.ts runs this command in memory against the invented shop, with a stand-in for Google that answers with the invented numbers, and checks that every line below is in what it prints."
$ npx gaugeline corner-pantry.example --pagespeed
```

```text title="Output (other checks' lines left out)"
· Real visitors' Core Web Vitals are not all good on a page
    Real visitors (Chrome, 75th percentile), https://corner-pantry.example/: Largest Contentful Paint needs improvement. 62% of loads were 2.5 s or faster; 75% are needed. 16% took longer than 4 s.
· A simulated phone load of a page scores under 90 (advice, not a verdict)
    Lab run, not real visitors: Lighthouse on Google's servers scored https://corner-pantry.example/ 42 out of 100 on a simulated phone (largest contentful paint 4.2 s, total blocking time 610 ms, layout shift 0.123, speed index 5.1 s). Advice only: one simulated load never passes or fails a page.
```

```text title="Stderr, before the first request"
--pagespeed sends the address of each page it reads (at most 5, no query string) to Google's PageSpeed Insights, only for public pages, and nothing at all with --allow-private.
```

The first finding is the one to act on: real visitors wait for that picture. The second only helps find why:
use its numbers to see where the time goes, and fix the cause the first one points at.

## The checks

| Check                    | What it reports                                                           | Severity       |
| ------------------------ | ------------------------------------------------------------------------- | -------------- |
| `pagespeed-field-vitals` | A vital that real visitors do not find good, per page and per vital       | medium, or low |
| `pagespeed-lab-advice`   | A simulated phone score under 90, with the numbers behind it. Advice only | low            |

Both are in the [checks reference](../checks.md). They are plain rules over the numbers in the answer: the same
answer gives the same findings, and no model is involved. Text in Google's answer is data: only numbers and the
page's address are kept, and nothing Google wrote reaches a finding.

## For developers

The reader is `packages/core/src/pagespeed/reader.ts` (one `GET` through the fetcher, with a longer wait than
other requests because Google loads the whole page before it answers), the answer is read field by field in
`vitals.ts`, and the checks are in `packages/core/src/checks/pagespeed.ts`, added to a run's registry only
with `--pagespeed`. A check reads `ctx.pageSpeed`, which is absent without the flag.

Running Lighthouse on your own machine is not built: it would have to run behind the same gate as the
[rendered pages](../rendered-pages.md), and nobody has measured that yet. The Chrome UX Report's own API is not
called: its only way to fetch a record is a `POST` that needs a key, and the same figures come back in the
answer above (decision record 0015, `docs/adr/0015-pagespeed-and-crux.md`).
