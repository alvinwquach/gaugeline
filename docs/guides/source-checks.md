# Checks that read your source: is the site really hidden?

Most Gaugeline checks look at a site the way a visitor or a search engine does. Some problems are easier to
see in the code than in the page, and some only exist in the code: a setting that quietly overrides another.
`gaugeline source <folder>` reads a project's folder and runs those checks.

**It only reads.** No request is sent to any site, no code is run, nothing is installed and nothing is
written. A link that leads out of the folder is never followed. `.env` files and other files that look like
they hold secrets (key files, `.npmrc`, `credentials.json`) are never opened: they are listed by name, and
nothing from inside them goes into a report. The folder is read up to a limit (2000 files, 512 KiB a file); a
folder bigger than that says so, and then no check passes, because what was left out may hold the problem.

**A check that cannot tell says so.** Gaugeline never turns "I could not read it" into a green tick: it
prints a `?` with the reason instead. A setting that depends on an environment variable is the usual reason,
because Gaugeline does not run your code.

## An example: a bar's site that is not meant to be found yet

Harbour Bar is a pop-up bar. The site is built with Next.js and its root layout says `noindex`, because it
is not ready to be found. Someone then added a menu page, a sitemap, and a line in `robots.txt`.

```text title="Terminal" untested="Reads a project folder. packages/cli/src/__tests__/source-docs.test.ts runs this command on the invented folder packages/fixtures/source/harbour-bar-preview and compares the output."
$ npx gaugeline source ./harbour-bar-preview
```

```text title=Output
Read 5 files in ./harbour-bar-preview. No request was made and no code was run.

✗ A page's robots setting replaces the layout's noindex
    app/menu/page.tsx:3 sets robots and says index: true, which replaces the robots in app/layout.tsx:5 (noindex)
✗ A sitemap is served while the site is set to stay out of search
    app/sitemap.ts serves a sitemap while the site is set to stay out of search (app/layout.tsx says noindex)
✓ robots-disallow-hides-noindex
✓ indexing-switch-loose
✓ noindex-smoke-production
✓ webhook-missing-secret-status
✓ sanity-cdn-tagged-reads
✓ cms-token-in-client-code
✓ webhook-url-hardcoded
✓ webhook-signature-compared-plainly
✓ webhook-timestamp-unbounded
✓ personal-data-in-analytics
✓ form-values-in-logs

2 to look at, 2 to fix first.
```

## Another example: a switch that accepts too much

Harbour Bar's team turns indexing on for the live site with an environment variable, `SITE_INDEXING`. The
layout treats anything but the word `false` as "on", and the only CI test for noindex runs on previews.

```text title="Terminal" untested="Reads a project folder. packages/cli/src/__tests__/source-docs.test.ts runs this command on the invented folder packages/fixtures/source/harbour-bar-switch and compares the output."
$ npx gaugeline source ./harbour-bar-switch
```

```text title=Output
Read 4 files in ./harbour-bar-switch. No request was made and no code was run.

! The indexing switch accepts more than "true"
    app/layout.tsx:3 SITE_INDEXING turns indexing on for any value except "false", so an unset variable or a typo turns it on
! The noindex smoke test runs on previews but not on production
    .github/workflows/preview-smoke.yml:10 tests noindex on previews, and no workflow tests it on production
✓ page-robots-overrides-layout
✓ sitemap-while-indexing-off
✓ robots-disallow-hides-noindex
✓ webhook-missing-secret-status
✓ sanity-cdn-tagged-reads
✓ cms-token-in-client-code
✓ webhook-url-hardcoded
✓ webhook-signature-compared-plainly
✓ webhook-timestamp-unbounded

2 to look at, none to fix first.
```

An unset variable on a new preview, or a typo such as `ture`, would put that preview in front of search
engines: only the exact word `true` should turn indexing on.

## The checks

These read the Next.js app router (`app/` or `src/app/`). The pages router is not read yet; a project
that uses it and has no `app/layout` says so and checks nothing.

- `page-robots-overrides-layout` (fix first): a page, or a nested layout, sets its own `robots` metadata
  without noindex, below a layout that says noindex. Next.js merges metadata shallowly, so the page's
  `robots` replaces the layout's whole: the layout looks like it hides the site, and this page puts itself
  back in. Fix: set `index: false` in the page, or remove its `robots`. When the layout reads a setting
  (an environment variable), the page overriding it is still reported, with that said.
- `sitemap-while-indexing-off` (fix first): the site is set to stay out of search (noindex in the root
  layout, or `Disallow: /` in `robots.txt`) and the folder still has a sitemap (`app/sitemap.ts`,
  `app/sitemap.xml/route.ts`, `public/sitemap*.xml`, or a `Sitemap:` line in `robots.txt`). A sitemap is a
  list of pages for crawlers; handing it over for a site you asked them to ignore works against your own
  setting. If a setting decides whether indexing is off, the check is not sure.
- `robots-disallow-hides-noindex` (fix first): `robots.txt` blocks a page that also says noindex. A crawler
  that is not allowed to fetch a page cannot read the noindex in it, so the instruction may never be seen
  and the address can still turn up in results. Rules are matched the way crawlers read them; a route with
  a dynamic segment (`/menu/[slug]`) counts as blocked only by a rule that covers everything before the
  segment. A `robots.ts` that builds its rules from code is not sure.

- `indexing-switch-loose` (fix soon): the environment variable that turns indexing on is accepted for more
  than the exact word `true`: `1`, `yes`, `!== "false"`, `Boolean(...)`, `!!...`, a bare `?` test, or the
  value passed on as it is. A variable counts as the indexing switch when it is read inside a `robots` value,
  in a robots file or near an `X-Robots-Tag` header, or has INDEX, CRAWL, ROBOTS or SEO in its name. A name
  that reads the other way round (`NO_INDEX`) is not judged: the check says it is not sure. The value of the
  variable is never printed.
- `noindex-smoke-production` (fix soon): a CI workflow in `.github/workflows` tests noindex (or
  `X-Robots-Tag`) on preview deployments, and no workflow tests it on production. A workflow counts as
  testing production when it says production or prod, or runs on `main`, and as testing previews when it says
  preview or runs on `pull_request` or `deployment_status`; one workflow that says both is not judged job by
  job. A project with no workflow files has nothing to miss and passes; a test that names neither is not sure.

The command also runs the other source checks: the Sanity publish webhook and the cache (see [the webhook and cache checks](webhook-and-cache-source.md)) and tokens and webhook addresses in code. A tick names each check that passed.

The first check cites the Next.js page on merging metadata; the others rest on what the Next.js file
conventions say a sitemap and a `robots` file are for, and on the way crawlers are documented to treat a
blocked page, which Gaugeline could not read when these checks were written. Each check's entry in the
[checks reference](/docs/checks) says what it relied on.

## What else is in the folder

`--json` prints the same result as any other run, with the file and line of each finding in `source`. With
`--ci` the exit code is 1 when a "Fix this first" finding is found, as in the other commands.
