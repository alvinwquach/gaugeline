# live

Small invented exports of the live Harbourline site, one per format `--live` reads, for the format
detection tests (G19). Nothing here is a real business.

- `crawl.csv`: a crawler's export (Address, Content Type, Status Code, …): a 404 row and a
  stylesheet that aren't pages.
- `search-console.csv`: a Search Console pages export (Top pages, Clicks, Impressions, CTR,
  Position), with a quoted "1,240".
- `sitemap.xml`: a sitemap with a paginated address.
- `list.txt`: one address per line, a path, a comment, a blank line and a feed.
- `plan.csv`: a three-row plan for the same site, for the docs example: `/company/press` is
  covered by its Legacy URL, so a Search Console export leaves two pages with nowhere to go.
- `gsc-pages.csv`: a 30-row Search Console pages export of the same invented site for `--rank`
  (G19a), with a "Date range" line above the header. Five of the 18 pages `live-nav.txt` leaves
  uncovered have clicks (1,661 in total); `/outsourced-healthcare-operations` is on two rows (https
  with www, and http bare, upper case, trailing slash) that add up to 1,240 clicks; three addresses
  are neither live nor planned.
