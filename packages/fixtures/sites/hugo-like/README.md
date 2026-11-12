# hugo-like

An invented bakery blog (Fennel Lane Bakery) that looks like a Hugo site built with
`--buildFuture` and `--buildDrafts`, for the static generator checks (FW-08). Nothing here is a real
business. The structure is what Hugo's own templates write (`<meta name="generator" content="Hugo ...">`,
`article:published_time`, a `sitemap.xml` that lists every built page); the draft badge class and
`/index.json` are the conventions themes use (uncited).

- `/` canonical and og:url are `https://example.org/`, Hugo's default `baseURL`: `static-preview-canonical`.
- `/posts/new-year-loaf/` is dated 2031-01-04: `static-future-post-live`.
- `/posts/winter-wheat-draft/` has a draft badge, no noindex, and is in the sitemap: `static-draft-marker-live`.
- `/index.json` (a probing check: only asked with `--owner-consent`) lists `/posts/wedding-cakes-draft/`,
  which the sitemap leaves out and which says noindex: `static-search-index-hidden`.
