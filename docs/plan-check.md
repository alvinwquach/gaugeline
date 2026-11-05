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
