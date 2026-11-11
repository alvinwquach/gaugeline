# Out-of-date copy: dates that have passed

The commonest embarrassing mistake on a small-business site is a promotion, a season or a notice that
ended months ago: "Happy hour through Oct 31", a "Summer 2025 menu", "Closed for the holidays until
Jan 3" still up in March, "© 2023" in the footer. The owner rarely notices. Customers do. Gaugeline
reads the words on the page, finds the dates in them, and says when a date has passed beside words that
promise something.

Two checks:

- `copy-date-passed` (Fix soon): a date in the page's visible text is in the past and sits next to a
  promotion or notice. The evidence is the sentence and the date it ends, and the finding is on the
  page it was read from.
- `copyright-stale` (Worth knowing): the footer's copyright year is before the current year. One
  finding for the page checked, not one per footer line.

Both read the page as it is sent, the copy a crawler receives. Neither calls a model: the same page on
the same day gives the same findings. Neither looks at anything but the checked page.

## What counts

Only visible text is read. Text in scripts, styles, `noscript`, hidden elements and comments is left
out, and so is anything in an attribute (an image's `alt`, a `title`, an `aria-label`): a poster's
description is not the page's copy.

A date is flagged when it is more than `graceDays` (1 by default) in the past, in the time zone of the
venue (the one set in the run, else UTC), and one of these is true:

- it follows an end word: "through", "until", "ends", "last day", "register by", "valid until", and
  the Spanish and French equivalents ("hasta", "jusqu'au"). A date with no year ("through Oct 31",
  "until Jan 3", "through September") is flagged on that alone: it is read as the occurrence nearest
  to today, so "until Jan 3" in March is the January just gone, and in late December the one ahead.
  A date that ends a range ("Sep 1 - Oct 31") counts as an end.
- it has a year ("Summer 2025", "Fall '25", "November 2025", "October 31, 2025", "10/31/2025") and a
  promotional word is within 40 characters: offer, special, deal, happy hour, menu, season, closed,
  holiday, hiring, sale, now, register, tickets and the like. A season ends with its last month
  (winter 2025 ends at the end of February 2026).

A date with no year and no end word is never flagged, a past date with no promotional word beside it is
never flagged ("Photos from our Oct 31, 2025 night"), and when a sentence also names a date still ahead
it is left alone.

The words are data, in English, Spanish and French, in `packages/core/src/data/stale-dates.json`. A
language is read when the page's `lang`, or your `gaugeline.languages.json`, names it.

## What is never flagged

- Pages that record the past: a page whose structured data says `Article`, `BlogPosting`,
  `NewsArticle` or `Report`, whose `og:type` is `article`, or whose path you list under `historic`.
- "Since 1998", "established 2010", "founded June 2010" and a date after "published", "posted",
  "updated" or "modified".
- A `<time>` that is an article's published or modified date, and every `<time>` inside an `<article>`.
- A numeric date that could be read either way ("10/11") and "open 24/7": Gaugeline would be guessing.
- A page that was cut at the size limit: the end was not read, so it is listed as could not check.

## Settings

Optional. `gaugeline.stale-dates.json` in the folder you run from:

```json
{
  "staleDates": {
    "graceDays": 2,
    "ignore": ["tasting night"],
    "historic": ["/journal/*", "/news/*"]
  }
}
```

- `graceDays`: days a date may be past before it is flagged. The footer year gets the same grace after
  1 January.
- `ignore`: a sentence containing any of these words (any case) is never flagged.
- `historic`: path patterns (`*` matches anything, `/` included) of pages that are records of the past.

## Example

A pop-up kitchen's home page still carries last summer's banner, "Every Thursday through September",
and a 2024 footer. The invented `popup-kitchen` fixture is that page. Version 0.1.0 prints:

<!-- fixture: popup-kitchen -->

```sh title=Terminal
$ npx gaugeline shop.example
```

```text title=Output
! A promotion or notice on the page has a date that has already passed
    "Summer 2025 menu: every Thursday through September 2025, 5 to 9 pm." ended 2025-09-30
· The footer copyright year is out of date
    the footer says "© 2024"
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 to look at, none to fix first.
```

The footer finding is on the same page as the banner. A bar's "Halloween special through Oct 31" is read
the same way, with the year worked out from today's date: on 12 November it is the 31 October just
gone, so it is flagged; on 20 October it is not.

## If you find one

Edit or remove the text. If it comes back every year, change the date and let the dated line come
from a field with an end date in your content system, so it can be hidden by itself. For a footer,
print the year from the date in the template: `new Date().getFullYear()` in Next.js, or the year
in the footer partial of your theme. If a page is meant to look back (a journal entry, a press
release), mark it as an article in its structured data, or list its path under `historic`.
