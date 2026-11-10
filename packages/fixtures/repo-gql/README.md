# repo-gql

An invented source tree for Northfield Coaching, a small business that sells coaching programmes and
keeps its free resource library in Sanity, read through Sanity's GraphQL API. It is what
`gaugeline query --graphql` reads in its tests and in docs/query-check.md. Nothing here is a real
business, and nothing in it is ever run: Gaugeline only reads these files, and it never sends a
mutation or a subscription.

- `schema.graphql` is the schema (SDL) of the invented API, with Sanity's shape: a `RootQuery`, a
  `Document` interface, and the types `Resource`, `Coach` and `Event`.
- `sanity-introspection.json` is the same schema as an introspection query answers it (a recorded
  answer in shape, written by hand, with the extra properties a server sends).
- `gql/resources.graphql` asks for `author` on `Resource`, which the schema does not have. The query
  starts on line 1, and that is the line a finding names.
- `src/lib/queries.ts` and `src/lib/fragments.ts` hold gql templates, one with a fragment
  interpolated from the other file; the fragment asks for `nickname`, which `Coach` does not have.
- `gql/enrol.graphql` holds a mutation and a subscription, which are counted and never sent.
- `src/lib/dynamic.ts` builds a query from a string and is listed as unreadable.
- `summary` is in the schema, and the invented dataset behind the tests has no resource with one.
- `schema.json` is Northfield's Studio schema as `sanity schema extract` writes it (the `resource`,
  `topic` and `coach` documents, and the `slug` type). It is what `gaugeline query --suggest --type
resource` takes its field names and kinds from; the counts come from an invented dataset in the
  tests (`NORTHFIELD_CONTENT` in packages/testkit), twelve published resources.
