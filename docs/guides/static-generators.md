# Static site generators

Hugo, Jekyll, Eleventy, Docusaurus and VitePress turn files into a folder of pages. The quiet failures
are about what went into that folder: a post you dated for next month, a draft the build included
because a flag was left on, an old version of the docs, a search box that knows about pages you hid.
Gaugeline looks at the pages the generator produced, from the outside.

## How a static site is recognised

From the page's `<meta name="generator">` tag: `Hugo 0.x`, `Jekyll v4.x`, `Eleventy v3.x`,
`Docusaurus v3.x` or `VitePress v1.x`. Without it, the checks below (except the development server
check, which reads the page's scripts) do not run. Hugo and Jekyll write the tag only when the theme
asks for it, so a site without it is simply not recognised.

## The checks

- `static-future-post-live` (fix first): the page's `article:published_time` or structured-data
  `datePublished` is more than a day after today. A day of grace covers time zones; a date with no zone
  is read as UTC. Only the date is shown.
- `static-draft-marker-live` (fix first): the page shows a draft marker (a `draft` badge class, or
  Docusaurus's draft and unlisted banners) and search engines may index it or the sitemap lists it.
  Class names only, never the page's text.
- `static-old-version-indexed`: a Docusaurus page whose banner says the version is no longer
  maintained (or unreleased) has no `noindex` and no canonical pointing elsewhere. VitePress has no
  versioning feature, so its version folders are not judged.
- `static-preview-canonical` (fix first): the canonical address, `og:url` or a sitemap entry uses
  `example.org`, `localhost` or a preview domain, which is what a generator writes when its base
  address was never set.
- `static-dev-server-live` (fix first): the page loads `/livereload.js` (Hugo, Jekyll),
  `/.11ty/reload-client.js` (Eleventy), the Vite client of a VitePress dev server, or Docusaurus's
  versionless development generator tag: the development server is the live site.
- `static-search-index-hidden` (fix first, **probing**): the site's search index lists pages the sitemap
  leaves out, and one of them says `noindex` or shows a draft marker. A VitePress index named in the
  site's own modules, or a JSON alternate link, is read like any visitor's browser would. The usual
  addresses (`/index.json`, `/search.json`, `/search-index.json`) are asked only with `--owner-consent`
  or a `gaugeline.consent.json`: run only on sites you own or have permission to test. Up to 4 pages
  the sitemap does not list are asked once each with `GET`. The report shows paths and counts only.

Not built, because a static site has nothing to build them from: a page-versus-data address that needs
`Vary`, private fields in embedded state, and a preview or draft route (a static folder has no routes
that switch modes). Hugo, Jekyll and Eleventy source files are read by the Git content adapter, not here.

## Example

A freelancer built a bakery's blog with Hugo and left `--buildFuture` on in the deploy. Against the
invented `hugo-like` fixture, the post dated for 4 January 2031 is already live, and version 0.1.0 prints:

```text title=Output
✗ A post dated in the future is already live
    article:published_time is 2031-01-04, in the future
? static-search-index-hidden could not be checked: this check asks for the site's search index at its usual addresses, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test (/posts/new-year-loaf/)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

1 to look at, 1 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. With `--owner-consent` (on a site
you own), the search index check also reads `/index.json` and reports a draft that the sitemap leaves
out but the site search still lists. The output is asserted by
`packages/cli/src/__tests__/static-generators.test.ts`.
