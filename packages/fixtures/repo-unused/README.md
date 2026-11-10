# repo-unused

An invented source tree for Marlow Physiotherapy, a small clinic with a Next.js site on Sanity. It is
what `gaugeline query --unused` reads in its tests and in docs/query-check.md. Nothing here is a real
business, and nothing in it is ever run: Gaugeline only reads these files.

It holds six queries in `src/lib/queries.ts`:

- `SERVICES_QUERY` is read by the services page and `ServiceCard`. `summary` is fetched and never read.
- `SERVICE_QUERY` is read by the service page and by `generateMetadata` (`seoTitle` is read only there).
  `practitioner.bio` is fetched and never read.
- `SETTINGS_QUERY` is fetched with `sanityFetch` and read in `Footer`. `instagram` is never read.
- `TEAM_QUERY` is read two components deep (`TeamGrid`, then `TeamCard`). `qualifications` is never read.
- `REVIEWS_QUERY` is read with a destructured parameter in a `map` callback. Everything is read
  (`_id` is not, and is never reported).
- `SEARCH_INDEX_QUERY` goes whole to `JSON.stringify` in a route handler, so it is "could not follow".

That is four unused fields and one query that could not be followed.
