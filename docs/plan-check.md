# Checking a launch plan

A rebuild starts as a spreadsheet. This checks the built site kept every promise in it.

Every migration begins as rows: the page, its address, its title tag, its H1, the keyword it targets and which old URL redirects to it. Nothing checks whether the site that got built matches.

```sh title=Terminal untested="Converted with a fixture in this page's own branch."
$ npx gaugeline plan sitemap.csv --base https://preview.yoursite.com
```

## What it reads

Any CSV with a URL column. Title Tag, H1, Primary Keyword, Secondary Keyword and Legacy URL are all used if present, and ignored if not. Column names are matched loosely, so an export from a spreadsheet usually works untouched.

## First, the plan against itself

- Two rows sharing one address — only one of them can exist
- Two rows planning the same title or heading
- A slug that misspells its own heading
- Two pages targeting the same primary keyword, which is cannibalisation before a line of code is written

::: info
Run it with --plan-only before anything is built. It needs no site, and it's the cheapest hour you'll spend on a migration.
:::

## Then, the built site against the plan

| Finding                            | What it means                                        |
| ---------------------------------- | ---------------------------------------------------- |
| Title tag isn't what the plan says | Someone edited the page, or the template overrode it |
| H1 isn't what the plan says        | Usually a content change nobody recorded             |
| Canonical points somewhere else    | Often still pointing at the legacy address           |
| No #section on the page            | An anchor row in the plan that was never built       |
| Returned 404                       | A planned page that doesn't exist yet                |

## The redirects

With a Legacy URL column, each one is requested and checked for a single hop, a 301 rather than a 302, and the right destination. This is the part that costs rankings when it's wrong, and the part nobody verifies until after cutover.

```text title=Output
✕ /apparel     redirects with 302, not 301
✕ /blog        still returns the old page
```

## Pages with nowhere to go

Pass --live with any export of the addresses that exist today — a crawl, a sitemap, a Search Console export — and it lists the ones the plan doesn't cover. A page that ranks and has no row in the plan is the most expensive thing on a migration.

```sh title=Terminal untested="Converted with a fixture in this page's own branch."
$ npx gaugeline plan sitemap.csv --live crawl-export.csv
```

::: warning
Exit code 1 when anything drifts, so this can gate a launch in CI.
:::

## In this version

What the code in this repository does today. The sections above describe the product as published
on the site.

`gaugeline plan <file>` reads the plan, says what it found, and checks the plan against itself;
`--base` also checks it against a built site and its redirects, and `--live` lists the pages that
exist today and have no row.
`--plan-only` runs only the checks of the plan against itself and makes no request. Any finding exits
1, so the plan can gate a launch in CI.

### What it reads

Any CSV with a URL column, exported from a spreadsheet as it is: a byte-order mark, Windows line
endings, a title row above the header, blank lines and quoted cells holding commas or line breaks
are all fine. Rows with no URL (menu labels, section headings) are skipped and counted. An address
with a `#section` is kept as its page and the anchor, so `/medical#rural` is the page `/medical`
and the section `rural`. A file with no URL column stops the run (exit 2) and lists the headers it
found. A multi-tab export pasted into one file, with a `## Sheet name: <tab>` line before each tab,
is read as a workbook (below).

### Workbooks and tabs

The plan can also be a whole workbook: an `.xlsx` file, or a multi-tab export pasted into one text
file with a `## Sheet name: <tab>` line before each tab. The file's first bytes decide how it is
read, not its name, so an `.xlsx` renamed to `.csv` still works. An old `.xls` file, or a
password-protected one, stops the run (exit 2) and says to save it as `.xlsx` or CSV. Every cell is
read as the spreadsheet shows it: dates as their displayed text, numbers without float noise.

The tab with the page list is chosen by its header: the one tab whose header has a URL column. If
several do, the first is read and a warning names the others; if none does, the run stops and
lists every tab with its headers. `--sheet <name>` picks a tab by name (case and surrounding spaces
don't matter). One line on stderr says which tab was read:

```text
Read tab: Kim's Keywords (6 other tabs skipped)
```

The other tabs are kept for the checks that read menus.

### The plan against itself

Before anything is built, each rule groups the rows that mean the same thing, in one pass, and every
group of two or more is one finding listing all its lines:

| Check                    | Level          | Two rows are the same when                                                                                                             |
| ------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `plan-duplicate-address` | Fix this first | Their address is: host without `www.`, path in lower case without a trailing slash or query, and the `#section`                        |
| `plan-duplicate-title`   | Fix soon       | Their title tag is, ignoring case, extra spaces and curly quotes. A brand suffix counts: "Billing" and "Billing \| Harbourline" differ |
| `plan-duplicate-h1`      | Fix soon       | Their H1 is, compared the same way                                                                                                     |

A fourth rule, `plan-slug-misspelling` (Fix soon), reads each slug against its own row: a word of
five letters or more in the last part of the address that isn't in the row's Page or H1, but is one
letter away from a word there (two for words of eight letters or more), such as `credentialling`
for "Credentialing" or `ambutatory` for "Ambulatory". It is excused when the two differ only by a
plural or tense ending (`payments` and "Payment", `billed` and "billing"), or are a British and
American spelling on the list (`optimise` and "optimize"). Accents are folded, so `resume` matches
"Résumé". Short words and abbreviations (`ar-management` for "Accounts Receivable Management")
never fire. The evidence names the corrected path.

#### Keywords

Two rules read the Primary Keyword and Secondary Keyword columns:

- `plan-keyword-cannibalisation` (Fix soon): two or more pages have the same primary keyword. They
  will compete for one search before a line of code is written.
- `plan-keyword-overlap` (Worth knowing): one page's primary keyword is listed as another page's
  secondary. This is often deliberate, supporting pages in a cluster, so it is reported from the
  primary's side at a lower level.

Keywords are compared exactly after tidying: case, extra spaces, curly quotes and a trailing full
stop don't matter. Nothing is stemmed, so "medical billing company" and "medical billing companies"
are different keywords. Empty cells, `n/a`, `none`, `tbd`, `-` and anything wholly in brackets, such
as "(branded news)", are left out. A Secondary Keyword cell can hold several terms separated by
commas, semicolons or line breaks. A page and its anchor rows count as one page. With a Primary
Volume column, the volume is shown and the groups are sorted by it, highest first; a volume that
isn't a number ("n/a (<10)") is shown as written and sorts last. A plan with no Primary Keyword
column skips these rules, with one line on stderr saying so.

Against the invented `keywords.csv` fixture, `gaugeline plan keywords.csv --plan-only` prints:

```text title=Output
Read 17 pages from keywords.csv.
Columns: URL from "URL", page from "Page", H1 from "H1", primary keyword from "Primary Keyword", secondary keyword from "Secondary Keyword".
2 rows are anchors (#section) on a page.
! Two rows in the plan have the same H1
    "Coding audits" on 2 rows
    lines 7, 14
! Two pages in the plan target the same primary keyword
    "medical billing services" (volume 590) is the primary keyword of 3 pages
    lines 3, 4, 5
! Two pages in the plan target the same primary keyword
    "patient payments" (volume 210) is the primary keyword of 2 pages
    lines 17, 18
! Two pages in the plan target the same primary keyword
    "credentialing services" (volume n/a (<10)) is the primary keyword of 2 pages
    lines 10, 11
· One page's primary keyword is another page's secondary
    "medical billing companies" (volume 90) is the primary for line 12 and a secondary for line 3
    lines 3, 12
· One page's primary keyword is another page's secondary
    "coding audits" (volume 30) is the primary for line 14 and a secondary for line 6
    lines 6, 14

6 to look at, none to fix first.
```

An anchor row (`/medical#rural`) and its page (`/medical`) are different addresses; two rows with
the same anchor are the same. Empty title and H1 cells are left out, and rows with no URL never
reach the checks. The example below shows two duplicate-address groups and two misspelled slugs.

### Old addresses in a notes column

Some plans keep the old addresses in a free-text column instead of a Legacy URL column ("301
legacy /old-page here."). `--legacy-from "<column>"` reads them out of that column (repeat it for
more than one). It only applies when the plan has no Legacy URL column: with both, the run stops
(exit 2) and says which to drop. Without it, one line on stderr names any column whose cells say
"legacy", with how many rows.

Each cell is split into sentences, and only sentences with the word "legacy" are read. A path is a
word that starts with `/` and has a letter in it (a full address is reduced to its path), with
trailing punctuation removed; a path that is one of the plan's own pages is dropped. Each sentence
is then one of:

| Kind             | The sentence                                                                 | What happens                          |
| ---------------- | ---------------------------------------------------------------------------- | ------------------------------------- |
| `redirect-here`  | has a path and says "301 … here", "redirect … here", "via 301" or "301 from" | The path becomes the row's legacy URL |
| `unconfirmed`    | has a path and starts with "Confirm", says "whether" or ends with "?"        | Listed as unresolved                  |
| `no-destination` | says "no destination"                                                        | Listed for review only                |
| `no-path`        | says legacy and 301 but names the page in words                              | Listed as unresolved                  |

Nothing else is turned into an address: "Link to /blog" or "FIX SLUG TYPO: /a should be /b" are not
about an old page, and a page named in words is never guessed. Every mention is printed in a review
table before any finding, with its line and the sentence it came from, and `--legacy-review <file>`
writes the same table as CSV for the spreadsheet's owner to confirm. The `no-path` and
`unconfirmed` mentions are one finding, `plan-legacy-unresolved`, listing every line.

Against the invented `legacy-notes.csv` fixture, `gaugeline plan legacy-notes.csv --plan-only
--legacy-from "SEO Notes" --legacy-review out.csv` prints:

```text title=Output
Read 12 pages from legacy-notes.csv.
Columns: URL from "URL", page from "Page", H1 from "H1".
Old addresses read from "SEO Notes" (10):
   line  kind            path                                sentence
      2  redirect-here   /old-services/medical-coding        Primary KD 8. 301 legacy /old-services/medical-coding here.
      3  no-path         -                                   301 legacy medical-billing page here.
      4  redirect-here   /old-services                       Absorbs legacy /old-services via 301.
      5  unconfirmed     /specialties/correctional-rcm       Confirm whether the legacy /specialties/correctional-rcm should redirect here.
      6  no-destination  /specialties/ophthalmology-billing  The legacy /specialties/ophthalmology-billing has no destination in the new sitemap.
     10  redirect-here   /old/labs                           301 legacy /old/labs here.
     10  no-destination  /old/lab-results                    The legacy /old/lab-results has no destination.
     11  unconfirmed     /old-services/medical-coding        301 legacy /old-services/medical-coding here?
     12  redirect-here   /old-contact                        301 from legacy https://www.harbourline.example/old-contact.
     13  redirect-here   /old-services/medical-coding        301 legacy /old-services/medical-coding here.

✗ One old address is claimed by two rows
    /old-services/medical-coding is the legacy address of 2 rows: /billing-services/coding, /specialties/pathology
    lines 2, 13
! Some old addresses in the plan's notes aren't settled
    3 mentions in "SEO Notes": line 3 (names the old page in words, not its address): "301 legacy medical-billing page here."; line 5 /specialties/correctional-rcm (asks whether to redirect): "Confirm whether the legacy /specialties/correctional-rcm should redirect here."; line 11 /old-services/medical-coding (asks whether to redirect): "301 legacy /old-services/medical-coding here?"
    lines 3, 5, 11

2 to look at, 1 to fix first.
```

Two notes send `/old-services/medical-coding` to two different pages (lines 2 and 13), and one
address can only redirect to one place: that is `plan-redirect-conflict` (see
[The 301 map](#the-301-map)).

### The built site against the plan

`--base <address>` checks the plan against a site that has been built, usually a preview:

```bash
npx gaugeline plan sitemap.csv --base https://preview.yoursite.com
```

Each planned path is moved onto that address and requested once with GET, however many rows sit on
it (a page and its `#section` rows are one request). Then each row is compared with what the page
sends, without running its JavaScript:

| Check                      | Level          | When                                                                                               |
| -------------------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| `plan-404`                 | Fix this first | The page answers 404 (or 410)                                                                      |
| `plan-canonical-elsewhere` | Fix this first | The canonical names another path, often the legacy address                                         |
| `plan-title-drift`         | Fix soon       | The title tag isn't the plan's. No title at all is reported with a hint that JavaScript may set it |
| `plan-h1-drift`            | Fix soon       | The first H1 isn't the plan's; a page with several H1s is noted                                    |
| `plan-anchor-missing`      | Fix soon       | A `#section` row's id isn't on the page                                                            |

Titles and headings compare the way the self-check does: case, spaces, curly quotes and dashes don't
matter, and a brand suffix does. A preview's canonical should already name production, so a canonical
on the preview's host, the plan's production host or either with `www.` passes when its path is the
planned one. A preview that asks for a password stops the run (exit 2) instead of reporting every
page; see [A preview behind a password](#a-preview-behind-a-password). `--plan-only` and `--base`
can't be used together. One line on stderr says how many
addresses are read.

Against the invented `plan-built` fixture, a pottery shop's preview with five planted errors,
`gaugeline plan plan.csv --base <preview>` prints:

```text title=Output
Read 10 pages from plan.csv.
Columns: URL from "URL", page from "Page", title tag from "Title Tag", H1 from "H1".
3 rows are anchors (#section) on a page.
✗ A planned page doesn't exist on the preview
    /gallery returned 404 on the preview
    line 9
✗ A canonical points somewhere other than the planned page
    /contact: the canonical is https://harbour-pottery.example/contact-us
    line 8
! A title tag isn't what the plan says
    /shop: the plan says "Shop | Harbour", the page says "Shop – Harbour Pottery"
    line 6
! An H1 isn't what the plan says
    /about: the plan says "About us", the page says "Our story"
    line 7
! A planned #section isn't on the page
    /faq#returns: no element has id="returns"
    line 10

5 to look at, 2 to fix first.
```

### The 301 map

With a Legacy URL column (or old addresses read with `--legacy-from`), `--base` also checks the 301
map. Each old address is moved onto the preview, requested once with GET, and its trail of
redirects is read:

| Check                             | Level          | When                                                                                     |
| --------------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `plan-redirect-missing`           | Fix this first | The old address still answers 200 or 404. A meta refresh or JavaScript redirect is named |
| `plan-redirect-not-301`           | Fix this first | The first redirect is 302, 303 or 307, or a 308 to the wrong place                       |
| `plan-redirect-wrong-destination` | Fix this first | The trail ends somewhere other than the row's URL                                        |
| `plan-redirect-chain`             | Fix soon       | More than one redirect, including a trailing slash added first                           |
| `plan-redirect-drops-query`       | Worth a look   | The old address's query string is gone at the end                                        |
| `plan-redirect-conflict`          | Fix this first | Two rows planning different pages claim one old address (no `--base` needed)             |

A cell may hold several old addresses, one per line or separated by commas; an absolute old address
keeps only its path, since it moves onto the preview. A trail may end on the preview's host or
exactly on the plan's production host; the right path on `www.` instead of the bare host (or the
reverse) is the wrong destination, because it costs every visitor another hop. A 308 to the right
place is accepted like a 301, with a note on stderr: it is permanent too. An old address that is
the row's own address needs no redirect and isn't requested.

Against the invented `plan-redirects` fixture, a bookshop's preview with five planted errors,
`gaugeline plan plan.csv --base <preview>` prints:

```text title=Output
Read 9 pages from plan.csv.
Columns: URL from "URL", page from "Page", legacy URL from "Legacy URL".
✗ An old address doesn't redirect
    /old-about still returns 200: it doesn't redirect
    line 8
✗ An old address redirects with a temporary status
    /old-poetry redirects with 302, not 301
    line 5
✗ An old address redirects somewhere the plan doesn't say
    /old-gifts redirects to /shop, the plan says /gifts
    line 7
! An old address takes more than one redirect
    /old-events takes 2 redirects: /old-events → /old-events/ → /events (the server adds a trailing slash first, then redirects again: point the old address's own form at the destination)
    line 6
· A redirect drops the old address's query string
    /old-blog?tag=news redirects to /blog without its query string ?tag=news
    line 10

5 to look at, 3 to fix first.
```

### A preview behind a password

Most previews are protected. Gaugeline reads the secret from one environment variable, never from a
flag, and sends it only to the `--base` address:

| Variable                   | Sent as                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `GAUGELINE_VERCEL_BYPASS`  | `x-vercel-protection-bypass` (Vercel's Protection Bypass for Automation)    |
| `GAUGELINE_BASIC_AUTH`     | `Authorization: Basic`, from `user:password` (the password may hold colons) |
| `GAUGELINE_PREVIEW_HEADER` | Any one other header, written `Name: value`                                 |

```bash
GAUGELINE_VERCEL_BYPASS=... npx gaugeline plan sitemap.csv --base https://preview.yoursite.com
```

- A redirect to another address gets no header: the secret goes to the preview's origin and nowhere
  else.
- The value is never printed. Messages and reports say `Vercel bypass (set)`, `basic auth (set)` or
  `header X-Name (set)`.
- A flag like `--password` is refused with the variable to set instead: a value on the command line
  lands in shell history, CI logs and the process list.
- Over plain `http`, a secret is sent only to `127.0.0.1` and `localhost`, with a warning.
- Netlify's site password is a form Gaugeline won't post. Protect the preview with Netlify basic
  auth instead (a `Basic-Auth` line in `_headers`) and set `GAUGELINE_BASIC_AUTH`.

Before reading the plan's pages, Gaugeline asks for the preview's home page once. A 401, a 403 or a
login page (Vercel's, or Netlify's password form) stops the run with exit 2, one message and no
findings: a locked preview says nothing about the plan. A 403 that isn't a password (a firewall
that blocks automated readers) says so, without asking for one. Without the variable, the invented
`preview-basic-auth` fixture (the pottery shop behind basic auth) prints on stderr:

```text title=Output
Could not check: the preview at https://preview.yoursite.com asked for a password (401, Basic).
Try: Set GAUGELINE_BASIC_AUTH to user:password.
```

If the home page opens and one planned page still asks for a password (a members area), that row is
"could not be checked", the rest are checked, and the run ends with exit 2 so CI can tell it from
drift. To pass the secret from CI, see [Use it in CI](/docs/ci#a-protected-preview).

### Watching a preview fill in

A preview fills in over weeks. `--progress` (with `--base`) remembers each run and says what changed:

```bash
npx gaugeline plan sitemap.csv --base https://preview.yoursite.com --progress
```

The last line counts the rows that match the plan (a row matches when no finding names its line) and
what changed since the last run: fixed, new and still open. Above it, only the news: new findings in
full, fixed ones one line each, and the still-open ones as a count (`--all` lists them too). The exit
code doesn't change: it stays 1 while anything is open.

The invented `plan-progress` fixture is a pottery studio's 10-row plan. In the first week 6 of its
pages are built (the first run prints `6 of 10 rows match the plan. First run: 4 open.`); a week
later 9 are, and the second run prints:

```text title=Output
Read 10 pages from plan.csv.
Columns: URL from "URL", page from "Page", title tag from "Title Tag", H1 from "H1".

✓ Fixed: A planned page doesn't exist on the preview (line 5 last time)
✓ Fixed: A planned page doesn't exist on the preview (line 7 last time)
✓ Fixed: A planned page doesn't exist on the preview (line 9 last time)
1 still open: add --all to list it.
9 of 10 rows match the plan (was 6). 3 fixed since 3 Oct, 0 new, 1 still open.
```

The state is a small JSON file, `.gaugeline/plan-state.json` beside the plan, or the file named after
`--progress`. It holds a fingerprint, the check id, the line and the title of each open finding, and
no page content, header or secret. In CI, keep it between runs with the cache.

- A finding is "the same" from run to run by its fingerprint: the check, the planned path and what
  it's about, never the line number, the preview's address or a count. Sorting the spreadsheet or a
  new preview address reports nothing new.
- Correcting a planned address (`/provider-credentialling` to `/provider-credentialing`) is a new
  path: the old finding counts as fixed, and anything wrong on the corrected one is new.
- Adding or editing rows says so: `(was 6 of 10; the plan changed)`.
- A run where a page couldn't be checked (a password, exit 2) saves nothing, so the next run still
  compares with the last complete one.
- A state file written by a later version is refused (exit 2) and left as it is. An unreadable one
  is kept as `.bak` and the run starts over.

### Live pages the plan misses

`--live <file>` reads what exists today and lists the pages with no row in the plan and no Legacy
URL pointing at them. It reads any of these, and decides which from the file's first line:

- a crawler's export with an `Address` column (rows with a Status Code other than 200 are left out);
- a sitemap (`<urlset>` or `<sitemapindex>`);
- a Search Console pages export (`Top pages`, `Clicks`, `Impressions`, `Position`);
- a plain list, one address or path per line.

Addresses compare on their path: case, a trailing slash and the query string don't matter. Assets,
feeds and paginated pages (`?page=2`, `/page/2`) aren't pages to plan for; `--ignore '/tag/*'`
leaves out more (`*` is one path segment, `**` any number). The file is read as a stream, so a
200,000-row crawl export doesn't fill memory. When the export has clicks (or impressions, or
position), the pages are sorted by them, most-visited first, with the number in the evidence.

When three or more live pages differ from planned rows only by a leading prefix (the plan says
`/resources/blog/…`, the site has `/blog/…`), that is one finding for the prefix, not one per page:
the plan assumes a structure that doesn't exist today.

Against a three-row invented plan (`packages/fixtures/plans/live/plan.csv`) and a Search Console
export of the same site, `gaugeline plan plan.csv --live search-console.csv` prints:

```text title=Output
Read 3 pages from plan.csv.
Columns: URL from "URL", page from "Page", title tag from "Title Tag", H1 from "H1", legacy URL from "Legacy URL".
✗ A page that exists today has no row in the plan
    /outsourced-healthcare-operations exists today and has no row or redirect in the plan (1,240 clicks)
✗ A page that exists today has no row in the plan
    /specialties/wound-care-billing exists today and has no row or redirect in the plan (310 clicks)

2 to look at, 2 to fix first.
```

`/company/press` is in the export too, and is covered: it is a row's Legacy URL.

### Sending the result back to whoever owns the spreadsheet

Each plan finding covers a group of rows (three rows on one address is one decision, so it is one
finding) and the terminal prints every line of the group under it. `--annotate` writes the plan's
tab again as CSV, every cell as it was read, with one more column, **Gaugeline**, saying what is
wrong on each row, so the owner can filter it in the spreadsheet:

```text
URL,H1,...,Gaugeline
/software/ai-automation,...,"plan-duplicate-address: same address as lines 147, 148"
/billing-services/coding,...,
```

A clean row's cell is empty, and a row with no URL reads `skipped: no URL`. Several findings on one
row are joined with `; `, most urgent first. The copy is named after the plan (`keyword-map.csv` gives
`keyword-map.gaugeline.csv`), or give a name: `--annotate notes.csv`. It is always CSV, even from an
`.xlsx`, and holds only the tab that was read. It never writes over the plan, and refuses to replace a
file that exists unless `--force` is given (exit 2). A copy fed back in has its Gaugeline column
replaced, not added again. The exit code is the same with or without `--annotate`.

### Column names

Names are matched loosely: case, spaces, underscores and punctuation don't matter
(`Title Tag`, `title_tag` and `TITLE-TAG` are one name). A header either maps or it doesn't, so
`URL notes` is never taken for the URL. When two columns map to the same thing, the first is used
and a warning names both.

| Read as           | Column names                                              |
| ----------------- | --------------------------------------------------------- |
| URL (required)    | URL, Address, New URL, Destination, New Address, Page URL |
| Page              | Page, Page Name                                           |
| Title tag         | Title Tag, Title, Meta Title                              |
| H1                | H1, Heading                                               |
| Primary keyword   | Primary Keyword, Keyword, Target Keyword                  |
| Secondary keyword | Secondary Keyword, Secondary Keywords                     |
| Legacy URL        | Legacy URL, Old URL, Current URL, Redirect From           |

Every other column is kept as it is, with the line number, so a finding can point back to the row.

### Example

```bash
npx gaugeline plan keyword-map.csv
```

Against the invented `keyword-map.csv` fixture, a billing company's keyword map with 167 rows and
12 columns, `gaugeline plan keyword-map.csv` prints:

```text title=Output
Read 163 pages from keyword-map.csv (4 rows without a URL skipped).
Columns: URL from "URL", page from "Page", title tag from "Title Tag", H1 from "H1", primary keyword from "Primary Keyword", secondary keyword from "Secondary Keyword", legacy URL from "Legacy URL".
7 rows are anchors (#section) on a page.
✗ Two rows in the plan share one address
    /software/ai-automation on 3 rows
    lines 146, 147, 148
✗ Two rows in the plan share one address
    /software/intelligent-platform on 2 rows
    lines 149, 150
! A slug misspells its own heading
    "ambutatory" in /billing-services/ambutatory-care, the heading says "ambulatory"; did you mean /billing-services/ambulatory-care
    line 4
! A slug misspells its own heading
    "credentialling" in /credentialing/provider-credentialling, the heading says "credentialing"; did you mean /credentialing/provider-credentialing
    line 61

4 to look at, 2 to fix first.
```

The output is asserted by `packages/cli/src/__tests__/plan.test.ts`.
