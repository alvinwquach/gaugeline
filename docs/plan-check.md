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

`gaugeline plan <file>` reads the plan and says what it found. The checks of the plan against itself,
against the built site (`--base`), the redirects and `--live` arrive in the next branches; `--plan-only`
is accepted now and makes no request.

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
```

The output is asserted by `packages/cli/src/__tests__/plan.test.ts`.
