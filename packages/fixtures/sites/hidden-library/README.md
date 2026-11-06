# hidden-library

An invented physiotherapy clinic building a `/library/` section behind a launch switch, for the
hidden-until-launch checks (N06). Nothing here is a real business, person or address.

- `/sitemap.xml` is a sitemap index; its child `/sitemap-pages.xml` lists `/library/guide`:
  `hidden-in-sitemap`.
- The footer links to `/library/`, and the nav's `/old-guide` redirects to `/library/guide`:
  `hidden-linked`.
- `/library/guide` answers 200 with no noindex: `hidden-indexable`. `/library/` itself is a 404.
- The launch date in `gaugeline.hidden.json` (2026-10-01) has passed: `hidden-past-launch`.
- `/beta/*` asks for a login (401), which is a pass.
