# Page snapshots: what each page lost

Comparing findings between runs tells you which findings are new. It can't tell you that a page
which had 1,240 words yesterday has 310 today: a page losing content isn't a finding until
something measures the page against itself. With `--since last`, Gaugeline saves a snapshot of
every page it reads, and on the next run compares each page with its own snapshot.

## What a snapshot holds

For each page read (the checked page and the other pages of the run's sample), saved in
`.gaugeline/` with the run:

- the words in the main content, and each section (an `h2` or `h3` and the words under it);
- the headings in order, the number of links and of images;
- each repeated list: a `ul` or `ol` with 3 or more items, or an element marked `data-list`, with
  its item count and the address each item links to;
- the structured-data types (JSON-LD `@type`, microdata `itemtype`);
- the title and the canonical address.

Counts, headings and addresses only: no page text is saved. The main content is `main`, or the
body when there is none, with the header, footer, navigation and asides left out, so a menu or
footer change (see [Navigation and footer](/docs/guides/navigation)) doesn't register as every page
changing.

## The checks

| Check                       | Level          | When                                                                    |
| --------------------------- | -------------- | ----------------------------------------------------------------------- |
| `page-lost-content`         | Fix this first | The main content fell by more than 40%, or a whole section is gone      |
| `page-gone`                 | Fix this first | A saved address answers 404 or 410, or redirects to another page        |
| `page-lost-items`           | Fix soon       | A repeated list has fewer items; the evidence names the item links gone |
| `page-lost-structured-data` | Fix soon       | A structured-data type the page had is no longer there                  |

- They run with `--since last`. On the first run nothing is saved yet: each is "could not be
  checked", and that run saves the pages. Without `--since last` they have nothing to compare,
  like the other change checks.
- Exactly 40% fewer words is not a loss; more than 40% is.
- A saved page that isn't in this run's sample is requested once with GET. A redirect that ends on
  the same path (a trailing slash, https) is the same page. A server error or a refusal is "could
  not be checked", never a pass.
- For a paginated list only the first page is compared, and the evidence says so.
- Gains are information, never findings: new pages, new sections and longer lists are printed on
  stderr under "Since the last run".

### A loss that was meant

List the page in `gaugeline.pages.json`, in the folder you run from, with the reason:

```json
{
  "expectedChanges": [{ "path": "/about", "reason": "the awards moved to /press" }]
}
```

The page is left out of the four checks, and the run says so once on stderr:
`Expected change, not reported: /about (the awards moved to /press)`.

## Example

The invented Fern and Kiln pottery studio (`packages/fixtures/sites/snap-before` and `snap-after`).

### The first run

Checked with `gaugeline fernkiln.example --since last`, which saves the pages:

```text title=Output
· Shared links have no picture
    no og:image on http://fernkiln.example/
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

Checked 4 of 6 other pages.
1 to look at, none to fix first.
```

### The next run

The About page loses its Awards section, the shop's list goes from 12 pots to 7, the glaze notes
lose their Article markup, Classes now redirects to Gift cards, and the footer changes on every
page. The same command prints:

```text title=Output
✗ The menu changed since the last run
    Removed: header › Classes (/classes); no page read links to /classes now
✗ A page from the last run is gone
    /classes redirects with 301 to /gift-cards now; last run it was a page of its own
✗ A page lost content since the last run
    139 words, now 101 (−27%); section gone: "Awards"
! A listing has fewer items than last run
    the list "Pots for sale" had 12 items, now 7; gone: /shop/nesting-bowls, /shop/butter-dish, /shop/olive-dish, /shop/serving-platter, /shop/bud-vase
! A page lost its structured data since the last run
    /glazes had Article structured data last run; the page has none now
· The menu changed since the last run
    Added: header › Gift cards (/gift-cards)
· The menu changed since the last run
    Added: footer › Contact (/contact)
· The menu changed since the last run
    Added: footer › Press (/press)
· The menu changed since the last run
    Renamed: footer › "Privacy" to "Privacy notice" (/privacy)
· The menu changed since the last run
    Renamed: footer › "Terms" to "Terms of sale" (/terms)
· Shared links have no picture
    no og:image on http://fernkiln.example/
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 4 of 8 other pages.
11 to look at, 3 to fix first.
```

and on stderr:

```text
Since the last run:
  New page: /gift-cards
```

The footer change is reported once, by the menu check, as the links it added and renamed; no page
check counts it. The home page, which didn't change, produces nothing.
