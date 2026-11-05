# Quick start

Check any website in about a minute. You need Node.js 18.17 or newer, and nothing else.

## Run a check

```sh title=Terminal untested="Shows version 0.1.0, which runs every check; this repository is at 0.0.x, which runs one. The tested example is under In this version."
$ npx gaugeline shop.example
```

Gaugeline loads the page without JavaScript, follows its redirects, reads robots.txt and the sitemap, checks the links and structured data, and scans the site's JavaScript for leaked keys. Then it writes `gaugeline-report.html` and opens it.

## What you'll see

```text title=Output
Gaugeline 0.1.0  checking shop.example

✕ This page tells Google to show a different page
  canonical on /macro-calculator points at /tools
✕ Your whole site exists at two addresses
  https://shop.example returned 200; it should 301
! Shared links may show no picture
  og:image is "/previews/landing.webp"
✓ A sitemap is available

3 to look at, 2 to fix first.
Report written to ./gaugeline-report.html
```

Every finding has a plain-English title for whoever owns the site, and a grey technical line for whoever fixes it.

## Next steps

- [Read the report](/docs/reading-the-report) to understand what each level means.
- [Add it to CI](/docs/ci) so a deploy fails when a page breaks.
- [Browse every check](/docs/checks) with what it catches and how to fix it.

## In this version

What the code in this repository does today. The sections above describe the product as published on the site.

Gaugeline needs Node.js 18.17 or newer.

```bash
npx gaugeline example.com
```

> Versions 0.0.x run a single check (`canonical-elsewhere`) while the release pipeline is proven.

A run prints what it is doing on stderr and the results on stdout. Against an invented page whose
canonical tag points at another page, version 0.0.x prints:

<!-- fixture: quick-start -->

```sh title=Terminal
$ npx gaugeline shop.example
```

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://shop.example/tools"> on https://shop.example/ (differs by path)

1 to look at, 1 to fix first.
```

On stderr, before the results, it says what it is doing:

```text
Gaugeline 0.0.2 checking https://shop.example/
 Loading the page without JavaScript
 Reading robots.txt and the sitemap
 Scanning the site's JavaScript for leaked keys
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

### In CI

```bash
npx gaugeline example.com --ci
```

exits 1 when there is a "Fix this first" finding. Setting the `CI` environment variable, as most CI
services do, has the same effect. See [Options](options.md).
