# model-clinic

An invented clinic site for X39 (content model changes on Sanity): "Fernbrook Physio", a made-up
physiotherapy practice whose freelancer added a required `summary` field to the `article` type and
then rebuilt the news pages. Nothing here is a real clinic, person or document. The tests run it as
`fernbrook.example` with an invented Sanity dataset (`FERNBROOK` in `@gaugeline/testkit`):

- 48 published articles, 17 of them (`article-32` to `article-48`) written before `summary` was
  required, so they have none (`model-missing-required`).
- `/services/sports-massage` prints the practitioner reference as text where the therapist's name
  should be (`model-unexpanded`). `/dev/content-ids` shows an id on purpose and is listed under
  `idsShownOn`.
- `/news` and `/news/page/2` show 31 of the 48 (the news query filters on `summary`):
  `model-listing-count`.
- The home page's "Latest from the clinic" block is empty (`model-dependents`).
- Two practitioners and four services still carry fields the schema dropped (`oldSpecialty`,
  `legacyNote`), named by `schema.before.json` (`model-orphan-fields`).

`schema.json` is what `npx sanity schema extract` writes after the change, `schema.before.json` what it
wrote before. Pages are plain files with relative links.
