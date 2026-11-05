# Sanity dataset cassette

`sanity-datasets.json` was written by hand, not recorded. The projects, datasets and answers are
invented, so no real dataset is in the repository, and tests never ask Sanity.

Each interaction answers the one query Gaugeline asks (`SANITY_QUERY` in packages/core/src/sanity.ts:
the document count and the distinct type names), in the shape of Sanity's query API (`result`).

- `ab12cd34/production`: public, 42 documents, types `order` and `post` (private-looking).
- `ab12cd34/blog`: public, 18 documents, types `author`, `post` and `siteSettings`.
- `pr1v4te0/production`: a private dataset that refuses the query without a token (401).
