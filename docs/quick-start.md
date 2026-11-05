# Quick start

Gaugeline needs Node.js 18.17 or newer.

```bash
npx gaugeline example.com
```

A run prints what it is doing on stderr and the results on stdout. Against a small test page that
redirects twice and asks not to be indexed, the output is:

```
Gaugeline 0.0.0 checking http://127.0.0.1:4000/
 Loading the page without JavaScript
 Reading robots.txt and the sitemap
 Scanning the site's JavaScript for leaked keys

✗ Google sees an almost empty page
    2 words in the server-rendered HTML outside header, nav and footer (fewer than 60)
✗ This page asks search engines not to list it
    <meta name="robots" content="noindex"> on http://127.0.0.1:4000/menu
! Your address takes several jumps to load
    2 redirects: http://127.0.0.1:4000/ (301) -> http://127.0.0.1:4000/home (301) -> http://127.0.0.1:4000/menu (200)
· The page doesn't say which address is the real one
    no <link rel="canonical"> on http://127.0.0.1:4000/menu
✓ canonical-elsewhere
✓ host-duplicate

4 to look at, 2 to fix first.
```

The indented lines are progress on stderr; a page with links also shows
` Checking 24 links on the page`. `--quiet` hides them.

`✗` is "Fix this first", `!` is "Fix soon", `·` is "Worth knowing" and `✓` is a check that
passed. The grey line under each finding is the technical detail for whoever fixes it.

When a run samples part of a page, a line before the summary says how much, for example:

```
Checked 24 of 61 links, 20 of 34 images, 25 of 310 sitemap pages.
```

A kind that was checked in full reads "all 24 links". Kinds with nothing found are left out. The
limits are fixed (see [Security](security.md#how-much-a-run-requests)); there is no flag to raise them.

## In CI

```bash
npx gaugeline example.com --ci
```

exits 1 when there is a "Fix this first" finding. Setting the `CI` environment variable, as most CI
services do, has the same effect. See [Options](options.md).
