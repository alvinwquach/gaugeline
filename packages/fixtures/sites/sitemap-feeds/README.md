# sitemap-feeds

An invented tea room on `feeds.test`, for the G09 robots, sitemap and feed checks.

- robots.txt names `/sitemap_index.xml`, a sitemap index that lists itself and `/sitemap-pages.xml`.
- `/sitemap-pages.xml` lists 30 pages. Entry 3 (`/old-menu`) is a 301 and entry 5 (`/closed-room`) is a 404.
  Only the first 25 are requested.
- The page advertises four feeds. `/feed.xml` (RSS) and `/atom.xml` (Atom) are valid, and `/events/feed` is a 404.
  `/press.xml` is the fourth and is never requested, because at most three feeds are read.
