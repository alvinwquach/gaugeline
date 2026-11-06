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
