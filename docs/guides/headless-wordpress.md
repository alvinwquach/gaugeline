# Headless WordPress sites

A restaurant, a yoga studio or a florist whose content lives in WordPress and whose website is a
separate JavaScript front end (Faust.js on Next.js, with WPGraphQL between them) has two doors to
guard instead of one: the website, and the WordPress back end behind it. These checks look at what
that split tends to leave open: a GraphQL API that describes itself to strangers, a preview link
that shows a draft, a preview address used as the canonical, and fields in the page's data that
the page never shows.

## How a headless WordPress site is recognised

From the page already fetched, and only when it is not a WordPress theme (no `/wp-includes/` or
`/wp-content/themes/` on the page): either the state Faust.js embeds in `__NEXT_DATA__` (an
`__APOLLO_STATE__` holding WordPress types such as `Post`, `Page`, `MediaItem` or `User`), or a
Next.js site that serves its images from `/wp-content/uploads/`. On any other site the checks below
are not run. Classic WordPress sites are covered by `wp-outdated` and `wp-users-exposed`.

## The checks

- `headless-wp-introspection-open` (fix soon, **probing**): the site's GraphQL endpoint (`/graphql` on
  the site, and on the back end its images come from) answers an introspection query with its schema
  to a visitor who is not logged in. WPGraphQL turns public introspection off by default, so someone
  turned it on. It sends **one `GET`** per endpoint with the smallest possible query in the address,
  `{__schema{queryType{name}}}`, which only says whether introspection is on: it is checked with
  Gaugeline's GraphQL parser and refused unless it is one query, it never asks for the schema, and
  it is never a `POST` or a mutation. An endpoint that answers a `GET` with an error status, or that
  only accepts a `POST`, is reported under "could not run", not as a pass. It runs only with
  `--owner-consent` (or a `gaugeline.consent.json`): **run only on sites you own or have permission
  to test**.
- `headless-wp-preview-open` (fix first, **probing**): a preview address the page itself links to (a
  query with `preview=true`, `preview_id` or `previewId`) answers a request with no cookie and no
  login with a page that carries a draft marker: a `status` of `draft`, `auto-draft`, `pending`,
  `private` or `future` in its embedded data, `isPreview`, or a draft title. A login redirect or a
  login form is the right answer. A page with no marker is "could not run": an unpublished page
  cannot be told from a published one without a marker, and absence of evidence is not a pass. Only
  the path and the parameter names are printed, never their values (they can carry a nonce). Same
  consent rule as above.
- `headless-wp-preview-canonical` (fix first): the canonical address, `og:url`, `og:image` or a
  sitemap entry is a WordPress preview link. A preview deployment host (`vercel.app`,
  `netlify.app`) used as the canonical is reported by `next-preview-canonical`.
- `headless-wp-private-fields` (fix first): the data embedded in the page has fields named like
  something private (`password`, `token`, `secret`, `apiKey` and a few more, matched by word),
  `email`, `username`, `roles`, `capabilities` or `registeredDate` on a `User` node, or posts whose
  status is not `publish`. **Names and counts only, never values.** The state is read up to 1 MB,
  100,000 nodes and 12 levels deep; a larger or cut one is "could not run".

The framework checks of the Next.js pack (`next-draft-public`, `next-preview-canonical`) apply to a
Faust.js site as well.

## Example

Against the invented `headless-wp` fixture, a restaurant on WordPress and Faust.js whose owner
agreed to the probing checks, run with `--owner-consent`, version 0.1.0 prints:

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="http://saltmarsh.test/?p=12&preview=true"> on http://saltmarsh.test/ (differs by query)
✗ The live site points search engines at a WordPress preview link
    canonical http://saltmarsh.test/?p=12&preview=true is a preview link
✗ A preview link shows an unpublished page without a login
    /specials (query: p, preview, previewPathname) answered 200 with no login and status draft in its data
✗ The data sent with a page has private fields or unpublished posts
    the embedded state has User.email, User.roles, apiToken; it holds posts that are not published (1 draft) (field names and counts only)
! Anyone can read the schema of your WordPress GraphQL API
    http://saltmarsh.test/graphql answers an introspection query with its schema (root type RootQuery) with no login
! Images still load from an old WordPress site
    1 image loads from /wp-content/uploads/: /wp-content/uploads/2026/11/harvest-table.jpg
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

6 to look at, 4 to fix first.
```

`canonical-elsewhere` reports the same canonical from the search side. Each check that passed also
prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/headless-wordpress.test.ts`.

## What was looked up

The Faust.js and WPGraphQL documentation sites (`faustjs.org`, `wpgraphql.com`) were not reachable
from the build machine on 11 November 2026, so the behaviour comes from the package source and a
search result, and is marked as such.

- Preview addresses: `@faustwp/core` 4.1.1 from npm (`dist/mjs/utils/isWordPressPreview.js`,
  `components/WordPressTemplate.js`): a preview is `?preview=true` with `previewPathname` and `p`
  query parameters; an unauthenticated visitor is redirected to the login address by the browser, and
  the draft is fetched with an authenticated client. The embedded Apollo state key
  `__APOLLO_STATE__`: `dist/mjs/client.js`.
- WPGraphQL turns public schema introspection off by default, and a setting under GraphQL, Settings
  turns it on: the WPGraphQL security page, as quoted in a search result. Its exact setting label
  was not confirmed.

Uncited, and said so in each check's technical line: the `/graphql` address (the plugin's default),
`preview_id` and `previewId`, the draft markers, and the words that mark a field name as private.

## Not checked

The WordPress REST API and the `wp-admin` paths are left to the WordPress checks, and nothing here
logs in, submits a form or asks for the schema beyond whether it is on. Faust.js previews that check
the login in the browser leave the server's HTML as a loading shell, so the preview check only reports
what a server actually sent.
