# Checking your queries

GROQ, GraphQL and the mutations you ship — checked against the content that actually exists, not just the schema.

Sanity's TypeGen compares your queries with your schema at build time, which catches a field you spelled wrong. It can't tell you that the field exists in the schema and is empty on every document you've ever published. That gap is where restructures go wrong.

```sh title=Terminal
$ SANITY_PROJECT_ID=abc123 SANITY_TOKEN=… npx gaugeline query ./src
```

## What it reports

| Finding                                      | What it usually means                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `author` doesn't exist on any resource       | The field was renamed. The page renders empty every time.                            |
| Nothing of type `topic` exists               | The type was renamed, or the content hasn't been created yet. Those pages are blank. |
| `gatedFile` is missing on 28 of 40 documents | Fine if it's optional. A bug if the template assumes it.                             |
| A query that doesn't exclude drafts          | Safe with the published perspective; a leak if anything runs it with drafts.         |

Every line carries the file and line number. The check asks the dataset for counts only, never content.

## Writing the query in the first place

The other direction: instead of checking a query you wrote, have it written from the content you have.

```sh title=Terminal
$ npx gaugeline query ./src --suggest --type resource
```

```text title=Output
// resource — written from 12 published documents
// publishedAt is present on 50% of the sample
// gatedFile is present on 33% of the sample
*[_type == "resource" && !(_id in path("drafts.**"))] | order(_updatedAt desc) {
  _id,
  title,
  "slug": slug.current,
  summary,
  topic->{ _id, title, "slug": slug.current },
  body,
  heroImage{ "url": asset->url, "alt": coalesce(alt, "") },
  tags[],
  "publishedAt": coalesce(publishedAt, ""),
  gatedFile{ "url": asset->url, "name": asset->originalFilename, "size": asset->size }
}
```

- Slugs unwrapped, references dereferenced, images and files resolved to URLs
- Fields that aren't on every document wrapped in `coalesce`, with a note saying how common they are
- Drafts excluded, newest first

::: warning
It describes what your content has today, not what your page needs. Read it, delete what the page doesn't use, and keep the query small: every field you ask for is data you pay to fetch and render.
:::

## GraphQL, the same way

If your project exposes Sanity's GraphQL API, or any other endpoint, the same command checks it. It reads your `.graphql` files and `gql` tags, introspects the schema, and reports fields that don't exist — then checks the same document types against the content, which introspection alone can't do.

```sh title=Terminal
$ npx gaugeline query ./src --graphql            # Sanity's GraphQL API for this project
$ npx gaugeline query ./src --graphql https://…  # or any endpoint
```

```text title=Output
GraphQL  https://abc123.api.sanity.io/v1/graphql/production/default
✕ author isn't in the schema
  allResource.author · gql/resources.graphql:1
```

## Mutations, checked without running them

A mutation is a write, and Gaugeline never writes. What it can do is read the mutations in your code — patches, creates, transactions, and the ones inside your webhook routes — and check their shapes against the schema and the content.

- A patch that sets a field no document type declares
- A create missing a field the schema marks required
- A reference written as a plain string instead of a _ref
- A mutation with no drafts handling, so it edits published content directly
- Two routes writing the same field, which is where drift starts

```sh title=Terminal
$ npx gaugeline query ./src --mutations
```

::: info
It reads them. It never sends them. Nothing here writes to your dataset, and a mutation check that executed would break that promise — see [What it can and can't write](/docs/writes) for the same answer across REST, GraphQL, SQL and queues.
:::

## Starting a page from your content

The same shape that writes a query can scaffold the route around it. The point isn't saving keystrokes: it's that the generated page already satisfies the checks people fail most.

```sh title=Terminal
$ npx gaugeline query --page --type resource --out "./src/app/resource/[slug]"

Wrote 3 files to ./src/app/resource/[slug] from 12 published resource documents
```

| File         | What's in it                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queries.ts` | List, detail and slug queries. Drafts excluded, fields that exist on your documents.                                                                                                        |
| `types.ts`   | A TypeScript interface. Fields missing on some documents are optional, so the compiler makes you guard them.                                                                                |
| `page.tsx`   | `generateStaticParams`, `generateMetadata` with the canonical and share tags, an image carrying the editor's alt text with width and height set, references linked, Portable Text rendered. |

::: info
Useful when building from scratch, and more useful during a restructure: generate against the migrated content and the scaffold reflects what actually arrived, including the fields that came over empty.
:::

It is not a page builder. There's no design in it, no layout opinions, and no component library. Treat it as the wiring: delete the fields this page doesn't render, then check the result with `npx gaugeline yoursite.com/resource/<slug>`.

## The same thing, twice

Duplicates are the other half of one source of truth: two documents that mean the same thing, at two addresses.

```sh title=Terminal
$ npx gaugeline query ./src --dupes

✕ 2 resource documents share the slug “claim-denials”
  only one can own the address. res-1, res-2
! 2 resource documents are called “MIPS guide”
  different addresses, same thing. res-3, res-4
```

A shared slug is a bug: one of them can't be reached. A shared title usually means content was duplicated rather than moved, which splits your search results between two pages.

## Before a restructure

1. Run it on the current code to get today's baseline.
2. Make the schema or template change.
3. Run it again: new gaps are the work the restructure created, listed with the files that need editing.

- **If you own the site:** This one's for your developer, but it's the check that stops a redesign quietly emptying pages.
- **If you run marketing:** If a section of the site renders blank after a rebuild, this is what finds it.
- **If you edit content:** If a field you fill in never shows up, this proves where it's being dropped.
- **If you build the site:** Pairs with TypeGen rather than replacing it: types catch schema drift at build, this catches content drift at runtime.

## GROQ or GraphQL

Sanity can expose a GraphQL API generated from your schema, which brings the typed-registry tooling GraphQL teams like. It costs you GROQ's projections, joins at arbitrary depth, `coalesce`, `select`, scoring and aggregation — so a wholesale swap is a trade, not an upgrade.

::: info
A middle path: keep GROQ, generate types with TypeGen, and run this check in CI. You get the part that matters from a schema registry — knowing before you ship — without rewriting your data layer.
:::
