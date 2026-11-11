# Migration completeness: nothing from the old site goes missing

You are moving a client's site from WordPress, Wix or Webflow to a new build, say Next.js with Sanity on
Vercel. The new site looks right and the home page loads. The client's old addresses are the part nobody
looks at: the blog post a regular shared last spring, the opening-hours page on the card in the window, the
result that comes up when someone searches for the bakery's wedding cakes. Each one has to land somewhere,
in one step, on a page with the title, the canonical address and the structured data it had.

`gaugeline migration` reads the old site's list of pages and checks every one on the new site. It only
looks. Every request is a `GET` through the same fetcher as the page check, up to 500 pages, and nothing is
sent anywhere. The old site's list is data: a title or an address in it is compared and printed as text and
never acted on. There is no model call: the same two sites give the same findings.

```sh
npx gaugeline migration preview.wrenbakehouse.example --old wrenbakehouse.example
```

## What it checks

| Check                         | Level          | It says                                                                                              |
| ----------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `migration-page-missing`      | Fix this first | An address the old site published answers 404 or 410 on the new one                                  |
| `migration-redirect-chain`    | Fix soon       | An old address needs two or more redirects to reach its page, or loops                               |
| `migration-title-changed`     | Fix soon       | The page's title is not the one it had                                                               |
| `migration-canonical-changed` | Fix soon       | The canonical was one address and is now another, and neither is where the page lives                |
| `migration-schema-type-lost`  | Fix soon       | The old page had structured data of a type (Article, FAQPage, Event, Product) that the new one lacks |

The first two need only the new site. The last three compare with the old page, so they need the old
site's own address while it is still up.

## Where the list comes from

| You give            | Gaugeline reads                                                                                                | Titles               | Old pages             |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------- |
| `--old <address>`   | The WordPress REST API: `GET /wp-json/wp/v2/posts` and `/pages`, published only, 100 at a time, no key         | Yes                  | Yes                   |
| `--old <address>`   | With no API: the sitemap (`/sitemap.xml`, `/wp-sitemap.xml`, `/sitemap_index.xml`), then the home page's links | No                   | Yes                   |
| `--old-file <file>` | A CSV or JSON export from Wix, Webflow or anything else, read from this computer. Nothing is requested for it  | If the file has them | Only with `--old` too |

`/wp-json` is WordPress's public, documented API, the one a theme's own JavaScript reads: asking for the
list of published posts and pages is not a probe, and `gaugeline migration` asks for nothing else under it.
It never touches `/wp-admin`, a login, a draft or a path that is not in the public list. Custom post types
(a menu, an event) are not in `posts` or `pages`: add them to an export and use `--old-file`.

A file needs one column, or key, that holds each page's address or path: `url`, `link`, `permalink`, `path`
or `address`. A `title` or `name` column is used when there is one. A slug alone does not say which folder
a page is in, so a Webflow collection's CSV needs a path column (the collection's folder plus the slug).
Each address is reduced to its path: the host is dropped, since the old and the new site differ, and an
address with a query string is left out and counted.

## Example: a bakery moves from WordPress to Next.js

Wren Bakehouse is an invented client: a bakery in Leith with a WordPress site, rebuilt by you on Next.js
and Sanity. The new site is on a preview address and the old one is still live. The WordPress API lists
twelve published items, four pages and eight posts. The new site has moved the blog under `/blog`, with
redirects.

```sh title=Terminal untested="Runs the built command against recorded responses for an invented bakery. packages/cli/src/__tests__/migration-docs.test.ts runs it (the docs runner points commands at one fixture site, and this one reads two) and compares the output with the block below."
$ npx gaugeline migration preview.wrenbakehouse.example --old wrenbakehouse.example
```

```text title=Output
Checking 12 pages from wrenbakehouse.example (the WordPress API) on preview.wrenbakehouse.example
✗ A page from the old site is missing on the new one
    /2026/04/christmas-orders/ ("Christmas orders are open") answers 404 on the new site
✗ A page from the old site is missing on the new one
    /wholesale/ ("Wholesale orders") answers 404 on the new site
! An old address takes more than one redirect to reach its page
    /2026/06/cardamom-buns/ takes 2 redirects: /2026/06/cardamom-buns/ -> /cardamom-buns -> /blog/cardamom-buns
! A page's title changed in the move
    /2026/08/new-rye-loaf/: was "The new rye loaf - Wren Bakehouse", now "Our rye, reworked | Wren Bakehouse"
! A page's canonical address changed in the move
    /2026/03/flour-supplier/: the canonical was /2026/03/flour-supplier/, now /blog
! A page lost a structured data type in the move
    /2026/05/wedding-cakes/: FAQPage lost (was Article, FAQPage; now Article)

6 to look at, 2 to fix first.
```

Six findings on six of the twelve pages:

- `/wholesale/` and `/2026/04/christmas-orders/` were not moved and have no redirect. These are the two to
  fix first: someone with the old link, or the old result in Google, lands on an error page.
- The cardamom buns post goes `/2026/06/cardamom-buns/` to `/cardamom-buns` to `/blog/cardamom-buns`. Point
  the old address straight at the last one.
- "The new rye loaf" is now "Our rye, reworked". If you meant it, leave it. If a CMS field was not mapped,
  put the title back.
- The flour supplier post names `/blog` as its canonical, so it asks Google to drop the post and keep the
  blog index.
- The wedding cakes post had FAQ markup (`FAQPage`) and the new page has only `Article`. The FAQ dropdown in
  search results goes with it.

The other six pages were found, reached in zero or one redirect, and kept their title, their canonical
and their types. `/about/` redirects once to `/about`, and `/opening-hours/` answers where it was. The home
page's WordPress name is "Home", which is never its title, so the home page is compared with the old
page's own `<title>` only.

## When the old site is gone: an export

After the cutover the old address is the new site, so there is no old page left to read. You can still
check the list. Wix and Webflow can export their pages and posts; keep the file, with a column for each
page's path. Here is an export of four of Wren's pages, saved as `wren-pages.csv`:

```csv title=wren-pages.csv
title,path
Wholesale orders,/wholesale/
Cardamom buns,/2026/06/cardamom-buns/
The new rye loaf,/2026/08/new-rye-loaf/
Opening hours,/opening-hours/
```

```sh title=Terminal untested="Same as above: packages/cli/src/__tests__/migration-docs.test.ts runs it with the file written into a temporary folder."
$ npx gaugeline migration preview.wrenbakehouse.example --old-file wren-pages.csv
```

```text title=Output
Checking 4 pages from wren-pages.csv on preview.wrenbakehouse.example
✗ A page from the old site is missing on the new one
    /wholesale/ ("Wholesale orders") answers 404 on the new site
! An old address takes more than one redirect to reach its page
    /2026/06/cardamom-buns/ takes 2 redirects: /2026/06/cardamom-buns/ -> /cardamom-buns -> /blog/cardamom-buns
! A page's title changed in the move
    /2026/08/new-rye-loaf/: was "The new rye loaf", now "Our rye, reworked | Wren Bakehouse"
? migration-canonical-changed could not be checked: no --old address was given, so the old pages were not read (the list came from a file) (/2026/06/cardamom-buns/, /2026/08/new-rye-loaf/, /opening-hours/)
? migration-schema-type-lost could not be checked: no --old address was given, so the old pages were not read (the list came from a file) (/2026/06/cardamom-buns/, /2026/08/new-rye-loaf/, /opening-hours/)

3 to look at, 1 to fix first.
```

The missing page, the chain and the changed title are found from the file alone, because the file has the
addresses and the names. The canonical and the structured data types need the old page, so those two checks
say they could not be checked, with the reason and the pages they skipped. They are never reported as
passed. Run the same command with `--old` while the old site is still up and they run too.

## How the checks decide

**Missing.** The new site is asked for the old path and its redirects are followed. A final 404 or 410 is
missing. A redirect that ends in a 404 is missing too, and the finding names where it went.

**One redirect.** One redirect is fine and none is fine. Two or more, or a redirect that never settles, is
the finding. The status of the redirect (301 or 302) is not judged here: `gaugeline plan` checks a 301 map
against a plan, and the page check reads redirects on a live site.

**Title.** Both titles are lower-cased with accents, punctuation and spacing taken out. They match when
they are equal or when one holds the other as whole words, so adding or dropping " | Wren Bakehouse" is not
a change and a reworded title is. The list's title (a post's name) is compared with the new page's
`<title>`, `og:title` and first heading. The old page's `<title>` is compared with the new `<title>` and
`og:title`. With neither an old title nor an old page, the page is listed as could not be checked.

**Canonical.** Only the path is compared, ignoring a trailing slash and case, because a preview and the
live site differ in host. The new canonical must be the old canonical's path, or the path the page now lives
at (a page that moved should name its new address). A page with no canonical on the old site is skipped.

**Structured data.** The `@type` of every JSON-LD node (an `@graph` is read through) and every microdata
`itemtype`, on both pages. Types that describe the whole site or the page in general (`WebSite`, `WebPage`,
`Organization`, `Person`, `ImageObject`, `SearchAction`) are left out, because themes and frameworks write
them in their own ways. A type the old page had and the new one does not is the finding; a new type is not.

A page the new site would not give (a 503, a password, a timeout) is listed under could not be checked in
every check and the command exits 2: a migration with unread pages is not finished.

## Before the cutover and after

| When                               | Run                                                   | What it can check                        |
| ---------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| New site on a preview, old is live | `migration <preview> --old <live address>`            | Everything                               |
| Day of cutover, both reachable     | `migration <live address> --old <old host's address>` | Everything                               |
| After, old site switched off       | `migration <live address> --old-file <export>`        | Missing, redirects, titles from the file |

If `--old` is the same site as the new address, Gaugeline says so instead of reading the new site as the
old one. The new address must come first.

## In CI and on the day

`--ci` makes a missing page exit 1, so a pull request that drops a page fails. Run it on the preview before
the DNS change, and again on the live address after. A page missing at that point is a visitor getting an
error.

```sh
npx gaugeline migration $PREVIEW_URL --old https://wrenbakehouse.example --ci
```

Exit codes: 0 ran, 1 with `--ci` a page is missing, 2 could not run (no list, a file that does not exist)
or a page could not be read.

## What it does not do

- It does not compare the page's content, only its address, title, canonical and structured data types. A
  page that answers 200 with the wrong text is not found here.
- It does not follow a redirect to the home page as a problem: a lazy catch-all redirect passes. Read the
  redirect rules too.
- It does not read custom post types, query-string addresses (`/?p=12`) or a site's private pages.
- It does not render JavaScript. It reads the HTML a crawler receives.
- Firecrawl's crawl endpoint as another source for the old site's list is not built yet.

## Related

- [Redirects and a launch plan](../plan-check.md): the 301 map against a plan.
- [Handoff](handoff.md) and [Renewals](renewals.md): what to hand over and what lapses after the move.
- [Options](../options.md#the-migration-command): every flag.
- [Privacy and safety](../privacy.md#migration-completeness-gaugeline-migration): what it asks for.
