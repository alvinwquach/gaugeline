# Sanity switches cassette

`sanity-switches.json` was written by hand (by a short script), not recorded. The project, documents
and answers are invented, so no real dataset is in the repository, and tests never ask Sanity.

Each interaction answers one request of the switches reader (`readSanityField` in
`packages/core/src/connectors/sanity.ts`): one field of the first published document of a type, as
`*[_type == "siteSettings"][0].features.preOrders`, in the shape of Sanity's query API
(`{ ms, query, result }`). The shapes are not confirmed against Sanity's current reference; see the
Sources of the pull request that added this file.

- `mar1gold/production`, a pop-up kitchen's `siteSettings` document: `features.preOrders` is `false`,
  `features.walkUps` is `true`, `features.closedFlag` is `"Closed"`, `features.notSet` is `null`,
  `features.note` is `"maybe later"` (not an on or off value); `eightySixed` is a list of two names,
  `emptyList` is `null` (Sanity leaves an empty list out) and `_id` is `"siteSettings"`;
  `capacity.remaining` is `0`, `capacity.left` is `38` and `capacity.bad` is `"plenty"`;
  `notAList` is a text. A type with no published document (`noSuchType`) answers `null`.
- `pr1v4te0/production`: a private dataset that answers 401 without a token.

Regenerate nothing by recording: edit the JSON by hand, or rebuild it with a script that imports
`productsUrl` so the addresses match the connector's.
