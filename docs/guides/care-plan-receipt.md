# The care-plan receipt: what you caught this month

A monthly care plan is easy to cancel when the client cannot see what it did. `gaugeline receipt` gives you one
page for the month: the problems Gaugeline found and that were fixed, the day each was first seen and the day
each was fixed, in plain groups, and what is coming up. It only restates the runs Gaugeline already keeps, so it
cannot claim more than they show.

```sh
npx gaugeline receipt <site> --month <yyyy-mm>
```

It looks and prints. It writes no file, sends nothing, and never renews or changes anything. It reads the runs
that `--since last` saves in `.gaugeline/runs/` (see [What changed, and who changed it](what-changed.md)),
so run your usual check with `--since last` every day, from a scheduled job, for the receipt to have something to
count.

## What it counts

- **Fixed.** A finding is fixed in a month when a run in that month read its page and no longer found it. The
  receipt gives the day it was first seen (the first run that had it) and "fixed by" (the first run that did not).
  A run that did not read the page cannot say the finding is gone.
- **Groups.** Booking and payments, listings and hours, site and content, renewals and security signals. A check
  Gaugeline does not file anywhere else is "Site and content". Groups with nothing in them are left out.
- **Renewals.** A domain, a token, a hosting project or the certificate of `www` belongs to the site, not to a page,
  so a run that used `--renewals` keeps these findings by their own address (`domain:marlowe-bar.example`,
  `token:github`, `vercel:<project>`, `https://www.marlowe-bar.example/`) and the receipt names that address where
  it would name a page. Each one is fixed in a month when a run that read that check no longer found it. A run
  that did not use `--renewals`, or in which a renewal check could not read what it needed (the registry did not
  answer), says nothing about it: it never ends a renewal and never opens one. Add `--renewals` to the daily run
  that uses `--since last` to have this group; runs saved before this was added hold no renewals, and the first run
  with `--renewals` starts them.
- **Still open.** A finding that is still there at the end of the month is listed as still open, not as a fix.
- **Dates and months.** Months and days are UTC, so the same month gives the same receipt on every computer. The
  default month is the last whole month; a month that is not over is the month so far.
- **Coming up.** With `--coming-up`, what lapses in the next 60 days: the domain's registration, the
  certificates, and any token you set up, read the way [`gaugeline renewals`](renewals.md) reads them (the
  public registry and the certificate, `GET` and `HEAD` only). Without it the receipt reads nothing but your own run
  history.

## "Before your customers did", and when it is not claimed

A fix is listed as caught **before your customers did** only when nobody reported it. If a client told you about a
problem first, say so with `--client-reported <check-id>[@<page>]` (repeatable): it is then listed on its own as
**fixed after you told us**, and it is never counted as caught first. The receipt cannot know on its own who noticed
a problem; it takes your word for the ones you name and counts the rest as caught first.

It never estimates money or traffic saved. There is no such number anywhere in it, in the Markdown, the JSON or
the printed page.

## Example: a bar's monthly care plan

Marlowe Bar is an invented client: a bar whose site you built and look after on a monthly plan. In October,
Gaugeline's daily check found the opening hours on a listing disagreeing with the site, then a different phone
number on another listing, and later flagged the domain as running out. You fixed the two listings and renewed the
domain. At the start of November you send this:

<!-- fixture: receipt-bar-october -->

```sh title=Terminal
$ npx gaugeline receipt marlowe-bar.example --month 2026-10
```

```text title=Output
# marlowe-bar.example: October 2026

This month: 3 fixed before your customers did.

| Area               | Fixed |
| ------------------ | ----: |
| Listings and hours |     2 |
| Renewals           |     1 |

## Fixed before your customers did

### Listings and hours

- **A listing shows different opening hours** (on /, seen Tue 6 Oct, fixed by Thu 8 Oct).
- **A listing shows a different phone number** (on /visit, seen Wed 14 Oct, fixed by Thu 15 Oct).

### Renewals

- **The domain's registration runs out soon** (domain:marlowe-bar.example, seen Tue 20 Oct, fixed by Sat 24 Oct).

## What was checked

31 daily checks ran on marlowe-bar.example in October 2026.
```

The sentences are the ones the weekly digest uses ("seen", "fixed by"), so a client who reads both sees one voice.
Paste the Markdown into the update you send, or print the page.

## Coming up

With `--coming-up`, a section like this is added when something lapses within 60 days:

```text title=Output
## Coming up

- Domain marlowe-bar.example: expires 20 Dec 2026, 36 days.
```

If the renewals cannot be read, the receipt is printed without the section and a line on stderr says so.

## A quiet month

When nothing was opened or fixed, the receipt says exactly that, with the true number of checks that ran:

```text title=Output
# marlowe-bar.example: September 2026

Nothing broke this month. 30 daily checks ran.
```

"Daily" is only written when there was one check on each of that many days; otherwise it says "12 checks ran". If no
check ran at all it says so and does not claim a quiet month.

## A page to print, and the JSON

- `--printable` prints one self-contained page (no script, no font, no image, no link) with a print style. Open it
  in a browser and save it as a PDF, or print it. Long lists are cut with "and 8 more, in the full receipt".
- `--json` prints the same receipt as data: counts are whole numbers, dates are ISO strings, and every fix has
  its first-seen and fixed dates. An app can show the same receipt from it. The Markdown, the JSON and the printed
  page are made from the same lines, so they always agree.

## Options

| Option                          | What it does                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `--month <yyyy-mm>`             | The month to report, in UTC. Default: the last whole month                         |
| `--client-reported <id[@page]>` | A fix your client reported first (repeatable); listed as "fixed after you told us" |
| `--coming-up`                   | Also read what lapses in the next 60 days, for "Coming up"                         |
| `--printable`                   | One page to print instead of Markdown                                              |
| `--json`                        | The same receipt as JSON on stdout                                                 |

See [options](/docs/options) for every flag, and [Renewals](renewals.md) for what `--coming-up` reads.

## How much history there is

Runs are kept for 90 days by default (`retentionDays` in `gaugeline.changes.json`), and at most the newest 500 runs of
a host are read. A receipt for a month older than that has less to count, and says "No checks ran this month" when
none are left. It never fills a gap in with a guess.
