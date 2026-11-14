# What a crawler gets

When an audit says your pages return no HTML, this settles it in one command.

React frameworks preload pages in the background. Those requests carry a prefetch header and return the framework's data format (`text/x-component`), not HTML. A crawler that renders JavaScript can record the preloads instead of the pages, and the report then claims your site returns no HTML.

## What Gaugeline records

- A normal request, with its content type and how many words a search engine can read
- The same address with the prefetch header (`RSC: 1`), which is expected to return app data
  (`text/x-component`)
- Whether the response tells caches the two differ (`Vary: RSC`)

Two checks read them, both high:

| Check                | When                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `rsc-served-as-page` | The normal request returns `text/x-component`, or HTML with no readable words while the prefetch request returns the page's data      |
| `rsc-vary-missing`   | The normal request returns HTML, the prefetch request returns `text/x-component` from the same address, and neither lists RSC in Vary |

They run in every site check too, on the checked page, when it is a React framework page (Next.js
signals in its response): one extra request, the same address with `RSC: 1`. Any other site gets
no extra request. `Vary: *` counts as listing RSC. When a CDN answered (a `cf-ray`, `x-cache` or
`via` header), the finding says the origin may send `Vary: RSC` and the CDN may be stripping it:
look at the CDN's cache key and header settings.

::: warning
The real bug in this area: serving both formats from one address **without** `Vary: RSC`. A shared cache can then hand the data format to a visitor or a search engine. Gaugeline flags that as high.
:::

## Re-check an audit export

```sh title=Terminal untested="The export is generated (packages/fixtures/src/crawl-export.ts): verify.test.ts runs it against the rsc-app fixture."
$ npx gaugeline verify crawl-export.csv --limit 40
```

It reads the address column and the issue name if there is one, sets aside rows that aren't pages, resolves prefetch rows back to the pages they belong to, and checks those directly. In one real audit, 4,061 of 4,180 "orphan URLs" were prefetch payloads.

### How rows are classified

`gaugeline verify` reads the export first, without a request. It finds the address column by its
name (Address, URL, a sitemap's `loc`), or, in an export in another language, as the first column
where most cells are web addresses. It reads the issue name too when there is a column for it
(Issue, Issue name). Each row then gets one kind, in this order:

| Kind             | What it is                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| prefetch payload | Next.js `?_rsc=` addresses and `/_next/data/…/*.json`, Nuxt `_payload.json`, Astro JSON under `/_astro/`. Each resolves to its page (minus `_rsc`) |
| asset            | Scripts, styles, source maps, images, fonts and PDFs, and anything under `/_next/static`, `/_astro` or `/_nuxt`                                    |
| data route       | `/api/` paths, and addresses ending `.json` or `.xml` that aren't sitemaps or feeds                                                                |
| page             | Everything else                                                                                                                                    |

Rows that resolve to the same page are one page: the host is compared in lower case, and a
fragment or a trailing slash makes no difference. Other query parameters are kept, so
`/shop?utm_source=mail&_rsc=1a` is the page `/shop?utm_source=mail`. A row with no address is
skipped and counted. The file is read as a stream, so a 200,000-row export is fine.

The invented Fern and Kiln export (4,180 rows, all filed under "Orphan URLs") gives:

```sh title=Terminal untested="The export is generated (packages/fixtures/src/crawl-export.ts): verify.test.ts runs this command on it and compares the output below."
$ npx gaugeline verify crawl-export.csv --limit 0
```

```text title=Output
4,061 of 4,180 orphan URLs were prefetch payloads
  4,061 prefetch payloads
     70 assets
     15 data routes
     34 pages
40 distinct pages behind them, the addresses to re-check
```

Without an issue column, the first line reads "4,061 of 4,180 rows were prefetch payloads".
`--limit 0` stops there: the rows are classified and no request is made.

### Re-check the pages

Then, for up to `--limit` pages (40 by default), the pages behind the most export rows first, then
by address, so the same export always checks the same pages: two GETs each, normally and with
`RSC: 1`, which is the only header added, and only on hops that stay on the page's own site. A
redirect is followed and the final address is checked. A page that answers 429, 503 or another
error is "could not be checked", never a finding. At most twice `--limit` requests, five at a time.

The same export, its 40 pages served by the invented `rsc-app` fixture, with `--limit 3`:

```sh title=Terminal untested="verify.test.ts runs this against the rsc-app fixture and compares the output below."
$ npx gaugeline verify crawl-export.csv --limit 3
```

```text title=Output
4,061 of 4,180 orphan URLs were prefetch payloads
  4,061 prefetch payloads
     70 assets
     15 data routes
     34 pages
40 distinct pages behind them, the addresses to re-check

Re-checked the 3 pages behind the most export rows:
  ✓ /  48 words; explains 103 export rows
  ✓ /about  47 words; explains 103 export rows
  ✗ /classes  rsc-vary-missing
      The address returns HTML to a normal request and text/x-component to RSC: 1, and neither response lists RSC in Vary: a shared cache can hand the data format to a visitor
3 pages re-checked: 2 return a readable page, 1 needs a fix. 306 export rows explained.
```

"Export rows explained" counts the prefetch payload rows behind the pages that answered. With
`--ci`, a finding exits 1.

- **If you own the site:** This is the one that saves your developer an afternoon of proving nothing is broken.
- **If you run marketing:** If an SEO report says your pages are missing, run this before anyone panics.
- **If you edit content:** Nothing to do here.
- **If you build the site:** Also useful after a deploy: confirm the pages an audit flagged are clean without waiting for the next crawl.
