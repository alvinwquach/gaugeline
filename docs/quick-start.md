# Quick start

Check any website in about a minute. You need Node.js 18.17 or newer, and nothing else.

## Run a check

```sh title=Terminal untested="The sample output above is the published site's wording for a real-looking shop, with checks that arrive in later versions. The tested example is under In this version."
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

Version 0.1.0 runs every check in the [checks reference](checks.md). (Versions 0.0.x ran a single
check, `canonical-elsewhere`, while the release pipeline was proven.)

A run prints what it is doing on stderr and the results on stdout. Against an invented page whose
canonical tag points at another page, version 0.1.0 prints:

<!-- fixture: quick-start -->

```sh title=Terminal
$ npx gaugeline shop.example
```

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://shop.example/tools"> on https://shop.example/ (differs by path)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

1 to look at, 1 to fix first.
```

Each check that passed also prints a `✓ <id>` line before the summary; they are left out above.

On stderr, before the results, it says what it is doing:

```text
Gaugeline 0.1.0 checking https://shop.example/
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

Only the kinds that were cut short appear; when everything found was read, there is no such line.
The report's "How much was sampled" lists every kind, cut short or not. The limits are fixed (see [Security](security.md#how-much-a-run-requests)); there is no flag to raise them.

### In CI

```bash
npx gaugeline example.com --ci
```

exits 1 when there is a "Fix this first" finding. Setting the `CI` environment variable, as most CI
services do, has the same effect. See [Options](options.md).

### Launch day

On the day a new site goes live, `gaugeline launch` runs only the checks that matter for the
cutover:

- links that still point at a preview address (`vercel.app`, `netlify.app`, `pages.dev`);
- a temporary address with no canonical tag;
- a share picture that doesn't load;
- a staging site search engines can index;
- `noindex`;
- a robots.txt that blocks the site.

```bash
npx gaugeline launch yoursite.com --dns
```

`--dns` adds the mail records a DNS change would break (SPF and DMARC). Without it the launch check
makes HTTP requests only. The last line says `Ready to launch` when nothing is "Fix this first",
and `Not yet: N to fix first` otherwise. With `--ci`, a fix-first finding exits 1, as for the
normal check. A check this version doesn't have yet is skipped with one line on stderr, for
example `stripe-test-mode: not available in this version`.

Against the invented `launch-preview` fixture, a pottery school with one link left on its preview
address, version 0.1.0 prints:

```text title=Output
✗ Links still point at a temporary address
    1 link to a temporary address: https://fernwood-git-main-studio.vercel.app/classes

1 to look at, 1 to fix first.
Not yet: 1 to fix first
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/launch.test.ts`.
