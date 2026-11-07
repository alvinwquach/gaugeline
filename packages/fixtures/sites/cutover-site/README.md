# cutover-site

An invented outdoor shop, Northgate Outfitters, live after its cutover, and its 10-row plan
(`plan.csv`) with 3 legacy addresses, for the 30-day cutover watch (G19c). Nothing here is a real
business.

Two known findings, left on purpose: `/press`'s title is "Press room | Northgate" where the plan
says "Press | Northgate" (plan-title-drift), and `/old-faq` doesn't redirect (404,
plan-redirect-missing). `/old-shop` and `/old-about` 301 to their pages.

The variants serve these files with one change each:

- `cutover-flipped`: `/old-shop` now redirects with 302 (one new finding).
- `cutover-fixed`: `/old-faq` now 301s to `/faq` (one known finding fixed).
- `cutover-down`: every address answers 503 (could not check).
