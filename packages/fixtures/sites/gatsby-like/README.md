# gatsby-like

An invented florist that looks like a Gatsby site from the outside (the `generator` meta,
`<div id="___gatsby">`, `window.pagePath` and `window.___webpackCompilationHash`, hashed
`webpack-runtime`/`framework`/`app` bundles, `page-data/<page>/page-data.json`,
`page-data/app-data.json` and `page-data/sq/d/<hash>.json`), for the Gatsby checks (FW-05). Nothing
here is a real business or deployment. The structure is the one Gatsby's own source writes
(`cache-dir/static-entry.js`, `cache-dir/loader.js`, `dist/utils/page-data-helpers.js`).

- `/___graphql` answers the GraphiQL page (`Gatsby - GraphiQL`): `gatsby-graphql-public` (a probing
  check: the folder holds a `gaugeline.consent.json`).
- The canonical points at `marigold-fern.netlify.app`: `gatsby-preview-canonical`.
- The page's data holds `internalNotes`, its static query holds `contactApiKey`:
  `gatsby-private-fields`; `staffNote` is not on the page: `gatsby-data-unshown`.
- The sitemap lists `/page-data/index/page-data.json`: `gatsby-data-as-page`.
