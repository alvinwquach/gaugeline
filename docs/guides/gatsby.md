# Gatsby sites

A florist, a bakery or a yoga studio built on Gatsby sends the browser more than the page. Every
page has a public data file behind it, every query result is written to a file anyone can open, and
a development server or a preview build can end up on the live address. These checks look at that,
using only what the site already serves to every visitor, plus one switch for the part that asks an
address a visitor would not normally ask.

## How a Gatsby site is recognised

From its markup: the `<meta name="generator" content="Gatsby ...">` tag, the `<div id="___gatsby">`
root element, or the inline `window.___webpackCompilationHash` script. On any other site the
checks below are not run.

## The checks

- `gatsby-graphql-public` (fix first, **probing**): `/___graphql`, the GraphiQL explorer that only
  `gatsby develop` serves, answers on the live address (an HTML page titled `Gatsby - GraphiQL`).
  One plain `GET` of that address; no query is sent and nothing is ever posted. It runs only with
  `--owner-consent` (or a `gaugeline.consent.json`): **run only on sites you own or have permission
  to test**. Without consent it asks nothing and says so under "could not run".
- `gatsby-preview-canonical` (fix first): the canonical address, `og:url`, `og:image` or a sitemap
  entry of a production page is on a preview domain (`vercel.app`, `netlify.app`, `pages.dev`,
  `gatsbyjs.io`, `gtsb.io`).
- `gatsby-data-as-page` (fix first): a page address answers with Gatsby's page data
  (`application/json` starting `{"componentChunkName"`), or the sitemap lists `page-data` addresses.
  No extra request is made.
- `gatsby-private-fields` (fix first): the page's own `page-data.json`, a static query it lists
  (`page-data/sq/d/<hash>.json`), or the page data inlined in its HTML has fields named like
  something private (`password`, `token`, `secret`, `apiKey`, `internalNotes` and a few more,
  matched by word). **Names only, never values.**
- `gatsby-dev-server-live` (fix first): the page was served by `gatsby develop`: its scripts include
  `/socket.io/socket.io.js`, `/commons.js` or `/framework.js`, the unhashed files only the
  development server writes. Read from the page already fetched.
- `gatsby-data-unshown` (worth knowing): text fields in the page's data files that are not on the
  page. Names only. A field a script uses, or another page reads, is listed too, so read it as a
  prompt, not a verdict.

The `page-data.json` of the page being checked, and the static queries it lists, are the files
Gatsby's own client asks for on every visit, so they are not probing requests. Gatsby does not ask
for the data of pages the checked page does not link to, for `app-data.json`, or for dev-only paths
such as `/__webpack_hmr`.

When a data file cannot be read (an answer that is not Gatsby's format, larger than 1 MB, cut, or an
error), the check says it could not check, with the reason; it does not pass the page.

## Example

Against the invented `gatsby-like` fixture, a florist copied from a preview build and left with the
development explorer reachable, run with `--owner-consent` because the owner agreed to it, version
0.1.0 prints:

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://marigold-fern.netlify.app/"> on http://marigold.test/ (differs by scheme, host)
✗ A page address returns Gatsby data, not a page
    the sitemap lists 1 page-data address
✗ The GraphQL explorer is reachable on the live site
    /___graphql answers the GraphiQL page (Gatsby - GraphiQL)
✗ The live Gatsby site points search engines at a preview deployment
    canonical https://marigold-fern.netlify.app/ is on a preview domain
✗ The data sent with a Gatsby page has fields that look private
    /page-data/index/page-data.json has internalNotes; /page-data/sq/d/2201.json has contactApiKey (field names only)
· The data sent with a Gatsby page has text the page does not show
    /page-data/index/page-data.json has 1 text field not on the page: data.allFlower.nodes[].staffNote (field names only)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

6 to look at, 5 to fix first.
```

`canonical-elsewhere` reports the same canonical from the search side. Each check that passed also
prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/gatsby.test.ts`.

## What was looked up

`gatsbyjs.com` was not reachable from the build machine, so every address and marker comes from the
source of the `gatsby` package (5.14.4) and `gatsby-graphiql-explorer` (3.14.0) from npm, read on 11
November 2026, and no live Gatsby site was looked at. The fixtures are invented and reproduce the
structure that source writes. These are [docs] citations of the package source, not of the
gatsbyjs.com pages.

- `page-data/<path>/page-data.json` (`index` for the home page), `page-data/app-data.json` and
  `page-data/sq/d/<hash>.json`: `cache-dir/loader.js`; the order of the keys
  (`componentChunkName`, `path`, `result`, `staticQueryHashes`) and the `data` and `pageContext`
  inside `result`: `dist/utils/page-data-helpers.js`, `dist/query/query-runner.js`.
- The generator meta and the inline `window.pagePath` and `window.___webpackCompilationHash`:
  `cache-dir/static-entry.js`; the `___gatsby` root: `cache-dir/default-html.js`.
- The development server's `/socket.io/socket.io.js`, `/commons.js` and `/framework.js`:
  `cache-dir/develop-static-entry.js`; production bundles are named with a content hash:
  `dist/utils/webpack.config.js`.
- `/___graphql` (the pattern `/_+graphi?ql`) and its page titled `Gatsby - GraphiQL`:
  `dist/utils/start-server.js` and `gatsby-graphiql-explorer/dist/index.html`. It is mounted only in
  the develop server.

Uncited, and said so in each check's technical line: the `gatsbyjs.io` and `gtsb.io` preview hosts
(from memory of Gatsby Cloud), and the words that mark a field name as private.

## Not checked

- Gatsby's preview refresh endpoint, `/__refresh`, accepts a `POST` only (and only when the develop
  server is started with `ENABLE_GATSBY_REFRESH_ENDPOINT`). Gaugeline never posts to a site, so it is
  not asked for.
- There is no `Vary` check: Gatsby serves a page and its data at two addresses, not one.
- There is no stale-page check: it needs a content source to compare against (a later version).
- Discovery still follows `/page-data/` links as it would any link; a later version can ignore them
  the way it does for Next.js.
