# schema-drift

An invented dental practice for the schema checks that need two pages or a reference:

- schema-id-drift: the Organization is `/#org` on the homepage and `/#organisation` on `/team`.
- schema-dangling-ref: the homepage's WebPage refers to `/#publisher`, defined nowhere.
- schema-breadcrumb-mismatch: `/team`'s breadcrumb ends at `/staff`.

`gaugeline.schema.json` sets only the breadcrumb rule, so the Organization ids are compared
between pages rather than against a configured id.
