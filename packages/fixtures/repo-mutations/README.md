# repo-mutations

An invented source tree for Larkspur Yoga Studio, a small studio with a Next.js site on Sanity. It is
what `gaugeline query --mutations` reads in its tests and in docs/query-check.md. Nothing here is a
real business, and nothing in it is ever run: Gaugeline only reads these files, and it never sends a
mutation.

- `schema.json` is what `sanity schema extract` writes for three document types: `classSession`,
  `instructor` and `announcement`.
- Four route handlers and one webhook handler write to the dataset, and each has something wrong with
  it on purpose.
