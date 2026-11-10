# Checking your queries

GROQ, GraphQL and the mutations you ship — checked against the content that actually exists, not just the schema.

Sanity's TypeGen compares your queries with your schema at build time, which catches a field you spelled wrong. It can't tell you that the field exists in the schema and is empty on every document you've ever published. That gap is where restructures go wrong.

```sh title=Terminal untested="Needs a Sanity project and a folder of source files. packages/cli/src/__tests__/query-docs.test.ts runs the same command against an invented dataset and compares the output with the block under What it reports."
$ SANITY_PROJECT_ID=abc123 SANITY_TOKEN=… npx gaugeline query ./src
```

::: info What works today
`gaugeline query <folder>` reads the GROQ in your repository and lists each query with its file and line. With `SANITY_PROJECT_ID` set it also asks your dataset how many documents of each type exist and how many have each field, and reports the four findings under [What it reports](#what-it-reports). Without it the command makes no request and needs no token. With `--dupes` it also names documents that share a slug or a title, and with `--mutations` it reads the writes in your code and checks their shapes against your schema file without sending any of them. GraphQL and suggested queries, which the rest of this page describes, are built branch by branch on top of this, and each part says so when it ships.
:::

## What the command reads

```sh title=Terminal untested="Needs a folder of source files, and the docs runner points every example at a fixture website. packages/cli/src/__tests__/query-docs.test.ts runs this command in a fixture repository (an invented bakery site) and compares the output with the block below."
$ npx gaugeline query ./src/app
```

```text title=Output
order  ./src/app/api/orders/route.ts:4
  fields: _id, total, lines[].item->name
  drafts: left out by the filter
  params: $email

popup  ./src/app/events/page.tsx:3
  fields: title, date, venue->name, venue->address.city
  drafts: not left out by the filter
  params: $after, $venue

menuItem  ./src/app/menu/[slug]/page.tsx:3
  fields: name, description, allergens[]->name, photo.asset->url
  drafts: not left out by the filter
  params: $slug

page  ./src/app/page.tsx:3
  fields: title, sections[]._type, sections[].heading, sections[].image.asset->url
  drafts: not left out by the filter
  params: none

Could not read 1 query:
  ./src/app/search/page.tsx:5  concatenated: built at run time (a template with an interpolation, strings joined with +, or a variable), so it cannot be read from the file

4 shapes from 4 queries; 1 could not be read.
```

That is Copperhill Bakery's pop-up site: a Next.js app on Sanity, built by a freelancer for a bakery that sells at markets. The order lookup, the events page, a menu item page and the home page each ask Sanity for a document type, and the search page builds its query from what a visitor typed.

- **Where it looks.** Every `.ts`, `.tsx`, `.js`, `.jsx` and `.mjs` file under the folder. It skips `node_modules`, `.next`, `dist`, `.git` and whatever your `.gitignore` names (a `.gitignore` in a subfolder counts below that folder), and it does not follow links.
- **What it finds.** `groq` tagged templates and `defineQuery("...")` calls, by reading the code with the TypeScript compiler, not by searching for text. A query you export from one file and import in another is found where it is written.
- **One block for each document type.** A query that filters on two types, such as `_type in ["post", "recipe"]`, gives two blocks that share a file and line. The line is the one the query's opening quote is on.
- **Fields.** The paths the projections read, as they are in the document: `"slug": slug.current` is `slug.current`, whatever it is renamed to. `topic->{ title }` is `topic->title`, and a `->` in a path means it crosses a reference. Nested objects keep the whole path (`contact.address.city`), and an array of objects is written `sections[].heading`. A `...` spread of an array reads the array itself. The filter and the `order()` are not fields: only what the query returns.
- **Drafts.** `left out by the filter` means every document must pass `!(_id in path("drafts.**"))` (or the same with `match`). A query that leaves drafts out some other way, such as the published perspective in the client, shows `not left out by the filter`, because the query itself does not say.
- **Parameters.** The `$names` the query takes.

### What it lists as unreadable

A query is never skipped without a word and never guessed. These are listed under "Could not read", with the file and line.

| Reason           | What it means                                                                                                                            | What to do                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `concatenated`   | The query is built when the code runs: a template with an interpolation, strings joined with `+`, or a variable passed to `defineQuery`. | Fine to leave. To have it read, write the whole query as one literal and pass the changing part as a `$parameter`. |
| `parse-error`    | The file does not parse as TypeScript or JavaScript (the line is the first error), or the string is not valid GROQ.                      | Fix the file or the query; the same error stops your build or your page.                                           |
| `no-type-filter` | The query parsed but nothing in it filters on `_type`, such as `*[_id == $id][0]`, so there is no document type to attribute it to.      | Fine for a lookup by id. Add a `_type` filter if you want it checked against that type.                            |

::: info Needs TypeScript beside it
The command reads your code with the TypeScript compiler, which is about 9 MB, so Gaugeline does not carry it for the checks that never need it. In a project that has it (any Next.js project written in TypeScript does), run `npx gaugeline query ./src`. Anywhere else, run `npx -p gaugeline -p typescript gaugeline query ./src`. Without it the command stops with exit code 2 and says this.
:::

It exits 0 when it read the folder, with or without unreadable queries, and 2 when the folder does not exist, TypeScript is missing or (with `SANITY_PROJECT_ID` set) the dataset could not be read. With `--ci` it exits 1 when a "Fix this first" finding is reported.

## What it reports

Set `SANITY_PROJECT_ID` (and `SANITY_DATASET`, `production` if you leave it out, and `SANITY_TOKEN` for a private dataset) and the command compares what your queries ask for with what the dataset holds.

```sh title=Terminal untested="Needs a Sanity project, and the docs runner points every example at a fixture website. packages/cli/src/__tests__/query-docs.test.ts runs this command in the invented bakery repository against an invented dataset (nine pop-ups, forty menu items) and compares the output with the block below."
$ SANITY_PROJECT_ID=cprhl1b4 npx gaugeline query ./src/app
```

```text title=Output
order  ./src/app/api/orders/route.ts:4
  fields: _id, total, lines[].item->name
  drafts: left out by the filter
  params: $email

popup  ./src/app/events/page.tsx:3
  fields: title, date, venue->name, venue->address.city
  drafts: not left out by the filter
  params: $after, $venue

menuItem  ./src/app/menu/[slug]/page.tsx:3
  fields: name, description, allergens[]->name, photo.asset->url
  drafts: not left out by the filter
  params: $slug

page  ./src/app/page.tsx:3
  fields: title, sections[]._type, sections[].heading, sections[].image.asset->url
  drafts: not left out by the filter
  params: none

Could not read 1 query:
  ./src/app/search/page.tsx:5  concatenated: built at run time (a template with an interpolation, strings joined with +, or a variable), so it cannot be read from the file

4 shapes from 4 queries; 1 could not be read.

Counted the published documents of 4 types in the dataset: one request each, counts only.

✗ A field your query asks for is on no document
    ./src/app/events/page.tsx:3  date doesn't exist on any popup: 0 of 9 documents have it. The field was probably renamed, so what shows it renders empty.
! A query does not leave drafts out
    ./src/app/events/page.tsx:3  The popup query's filter does not leave drafts out. That is safe when the client asks for the published perspective, and leaks unpublished content if anything runs it with drafts.
! A query does not leave drafts out
    ./src/app/menu/[slug]/page.tsx:3  The menuItem query's filter does not leave drafts out. That is safe when the client asks for the published perspective, and leaks unpublished content if anything runs it with drafts.
! A query does not leave drafts out
    ./src/app/page.tsx:3  The page query's filter does not leave drafts out. That is safe when the client asks for the published perspective, and leaks unpublished content if anything runs it with drafts.
· A field your query asks for is missing on some documents
    ./src/app/menu/[slug]/page.tsx:3  allergens is missing on 28 of 40 documents. Fine if it is optional; a bug if the template assumes it.
✓ query-type-empty

5 to look at, 1 to fix first.
```

A `✓` line is a check that found nothing (no type is empty here). Copperhill Bakery's freelancer renamed the pop-up's `date` field to `startsAt` in the Studio a month ago. The page still asks for `date`, TypeGen is satisfied because the schema has no opinion about a query string, and the events page has been showing no dates since. That is the first finding. The same dataset shows the other three kinds.

| Finding                                                             | Level          | What it usually means                                                                |
| ------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| `query-field-absent`: `author` doesn't exist on any resource        | Fix this first | The field was renamed. The page renders empty every time.                            |
| `query-type-empty`: nothing of type `topic` exists                  | Fix this first | The type was renamed, or the content hasn't been created yet. Those pages are blank. |
| `query-field-partial`: `gatedFile` is missing on 28 of 40 documents | Worth knowing  | Fine if it's optional. A bug if the template assumes it.                             |
| `query-no-drafts-filter`: a query that doesn't exclude drafts       | Fix soon       | Safe with the published perspective; a leak if anything runs it with drafts.         |

Every line carries the file and line number the query starts on. A field that two queries read is reported once for each query, each with its own file and line. A type with no documents is reported once, and its fields are not reported as well, because none of them can exist.

### How the counting works

- **One request for each document type**, not one for each field. A repository with 8 types and 90 field uses makes 8 requests. Each is a `GET` of Sanity's query address for published documents only, asking for `count(*[_type == "popup"])` and one `count(*[_type == "popup" && defined(date)])` for each field. The fetcher allows 5 requests at a time.
- **Counts only, never content.** The answer is a list of whole numbers. Gaugeline never asks for a document, a field's value or a sample, because a check that fetched one document to look at its keys would be reading your content with a token.
- **A reference is counted at the reference field.** `venue->name` counts `venue`, not the venue's name, because the venue is another document. An array of objects is counted the same way: `sections[].heading` counts `sections`. `_id`, `_type`, `_rev`, `_createdAt` and `_updatedAt` are on every document and are not counted.
- **A wide type is sent in two halves** when its query would be too long for a `GET` (about 8,000 characters, which is around 60 to 80 fields). That takes two or more requests for that one type, and the run says so on stderr.
- **Names are quoted.** A field called `gated-file`, or one named after a GROQ word such as `in` or `match`, is written as `["gated-file"]` in the count query.
- **A private dataset needs a token.** Without `SANITY_TOKEN` Sanity refuses, and the command stops with exit 2 and one message that names `SANITY_TOKEN` and the Viewer role. Make the token under API in sanity.io/manage with the Viewer role; see [Private datasets](/docs/private-datasets). With `SANITY_DATASET` unset the dataset `production` is used, and stderr says so.

`--json` prints the usual result (schema 2), with each finding's `source` holding the file and line, and the number of types counted under `sampled`. It needs `SANITY_PROJECT_ID`. What is sent, and what is kept: [Privacy and safety](/docs/privacy#sanity-datasets).

## Writing the query in the first place

The other direction: instead of checking a query you wrote, have it written from the content you have.

```sh title=Terminal untested="Converted with a fixture in this page's own branch."
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

```sh title=Terminal untested="Converted with a fixture in this page's own branch."
$ npx gaugeline query ./src --graphql            # Sanity's GraphQL API for this project
$ npx gaugeline query ./src --graphql https://…  # or any endpoint
```

```text title=Output
GraphQL  https://abc123.api.sanity.io/v1/graphql/production/default
✕ author isn't in the schema
  allResource.author · gql/resources.graphql:1
```

## Mutations, checked without running them

A mutation is a write, and Gaugeline never writes. What it can do is read the writes in your code (patches, creates, transactions, and the ones inside your webhook routes) and check their shapes against your schema. `--mutations` does that. It needs no `SANITY_PROJECT_ID`, no token and no network, because nothing here asks your dataset anything.

The schema comes from a file you write once: `npx sanity schema extract` makes `schema.json`, and `--schema ./path/schema.json` points at another one. Without `--schema` it looks for `./schema.json` where you ran the command, then `schema.json` in the folder it reads. If it finds neither the command stops with exit code 2 and says so. It does not fetch the schema itself: a request is the thing this command promises not to make.

```sh title=Terminal untested="Needs a folder of source files and a schema file, and the docs runner points every example at a fixture website. packages/cli/src/__tests__/query-docs.test.ts runs this command in the invented studio repository (packages/fixtures/repo-mutations) and compares the output with the block below."
$ npx gaugeline query ./app --mutations
```

```text title=Output
Read 5 writes in 5 files (1 transaction, 3 patches and 1 create) and checked them against the schema. They were parsed, not run: nothing was sent.

Checked on the fields that are visible (a spread or a variable hides the rest):
  ./app/api/webhooks/sanity/route.ts:11

Could not read 1 write:
  ./app/api/webhooks/sanity/route.ts:12  variable-key: a field name comes from a variable or an expression, so the field cannot be read from the file

✗ A write sets a field no document type declares
    ./app/api/classes/[id]/status/route.ts:6  This patch writes cancelledBy, and no document type in the schema declares it. Sanity stores it anyway, but the Studio shows no field for it and nothing the schema validates will see it.
✗ A create leaves out a field the schema requires
    ./app/api/classes/route.ts:6  This create of classSession leaves out startsAt, which the schema marks required. The document is saved, and the Studio shows it as invalid.
✗ A reference is written as a plain string
    ./app/api/classes/route.ts:6  instructor is a reference, and this create gives it a plain string. A reference is an object: { _type: "reference", _ref: "the document's id" }.
! A write edits published content directly
    ./app/api/classes/[id]/status/route.ts:6  This patch has no drafts handling: its id is not a drafts. id, so it changes the published document directly and an editor's unpublished edits can be lost or published.
! Two routes write the same field
    classSession.status is written by 2 routes: ./app/api/classes/[id]/status/route.ts:6, ./app/api/cron/reopen/route.ts:7. If they disagree about its value the last write wins, which is where drift starts. Fine if they are meant to share it.

5 to look at, 3 to fix first.
```

That is Larkspur Yoga Studio's site, built by a freelancer: a Next.js app on Sanity with four route handlers and a webhook that write to the dataset. The booking form creates a class and gives the instructor as a plain id, with no start time. The front desk's cancel button and the morning cron both write `status`, and the cancel button also writes a field called `cancelledBy` that the schema has never heard of. Every one of those is accepted by Sanity without an error, which is why they are found by reading and not by running.

| Finding                                                                       | Level          | What it usually means                                                                            |
| ----------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------ |
| `mutation-undeclared-field`: a patch sets `cancelledBy`, which no type has    | Fix this first | A renamed field, or a typo. The data is stored and the Studio never shows it.                    |
| `mutation-missing-required`: a create of `classSession` leaves out `startsAt` | Fix this first | The document is saved and the Studio marks it invalid. A page that needs the field breaks on it. |
| `mutation-ref-as-string`: `instructor` is given a string                      | Fix this first | The reference never resolves, so every `->` that follows it gets nothing.                        |
| `mutation-no-drafts`: a patch with no drafts handling                         | Fix soon       | An editor's unpublished changes can be lost, or published by the next write.                     |
| `mutation-shared-field`: two routes write `classSession.status`               | Fix soon       | Each assumes it owns the field. Fine when they are meant to share it.                            |

Every finding carries the file and line of the write. `--json` prints them in the usual result (schema 2) with each finding's `source`, and `--ci` exits 1 when a "Fix this first" one is reported. With `SANITY_PROJECT_ID` set as well, the counts and the mutation findings come in one report.

### What it reads

- **Where.** Every `.ts`, `.tsx`, `.js`, `.jsx` and `.mjs` file under the folder, the same files and the same skips as for queries. Route handlers (`app/**/route.ts`, `pages/api/**`) are named by their address, so "two routes" means two addresses; a write outside a route is named by its file.
- **Which calls.** `patch(...)` with `set`, `setIfMissing`, `unset`, `inc`, `dec`, `append`, `prepend` and `insert`; `create`, `createOrReplace`, `createIfNotExists` and `delete`; `transaction()` chains, also kept in a variable (`const tx = client.transaction()`), with the builder form `patch(id, (p) => p.set(...))`; and raw mutations arrays (`client.mutate([...])`, or a `mutations` key in a request body). The receiver has to be named like `client` or `sanity`, so `stripe.customers.create` and `Object.create` are not mistaken for writes.
- **Drafts.** A write handles drafts when its id starts `drafts.` (a string, a template, or `"drafts." + id`) or comes from something named like a draft helper (`getDraftId(id)`). A `create` makes a new document, so it is not checked for this.
- **Which type a patch is for.** A patch does not say. A field that exactly one type declares is attributed to that type for `mutation-shared-field`; a field that several types declare is not compared, because the answer would be a guess. A create is checked against the `_type` it names.
- **Required and references.** From the schema file: an attribute is required unless it says `optional: true`, and a reference is an object that dereferences. A create that spreads another object (`...base`) is checked on the keys that can be seen and listed as partly read; it is never reported as missing a field the spread may carry.
- **A write built from a variable is never guessed.** A field name that comes from a variable, or a payload that is a variable the file does not settle, is listed under "Could not read" with its file and line. A `const` object in the same file is read through, because the file settles it.

::: info
It reads them. It never sends them. Nothing here writes to your dataset, and a mutation check that executed would break that promise. The module that reads mutations (`packages/core/src/query/mutations.ts`) cannot import the fetcher, the Sanity reader or an HTTP client, and a test fails the build if it ever does. Another test runs the command with `fetch`, `node:http`, `node:https` and `node:net` replaced by functions that throw, and with a transport that fails the test if it is called at all. See [What it can and can't write](/docs/writes#the-promise-test) for the same answer across REST, GraphQL, SQL and queues.
:::

## Starting a page from your content

The same shape that writes a query can scaffold the route around it. The point isn't saving keystrokes: it's that the generated page already satisfies the checks people fail most.

```sh title=Terminal untested="Converted with a fixture in this page's own branch."
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

Duplicates are the other half of one source of truth: two documents that mean the same thing, at two addresses. `--dupes` asks your dataset for the id, the slug and the title of every published document of the types your queries read, and names the ones that share a slug or a title.

```sh title=Terminal untested="Needs a Sanity project, and the docs runner points every example at a fixture website. packages/cli/src/__tests__/query-docs.test.ts runs this command in the invented bakery repository against an invented dataset and compares the output with the block below."
$ SANITY_PROJECT_ID=cprhl1b4 npx gaugeline query ./src/app/menu --dupes
```

```text title=Output
menuItem  ./src/app/menu/[slug]/page.tsx:3
  fields: name, description, allergens[]->name, photo.asset->url
  drafts: not left out by the filter
  params: $slug

1 shape from 1 query.

Counted the published documents of 1 type in the dataset: one request each, counts only.

Read the ids, slugs and titles of the published documents of 1 type to look for duplicates: one request each. A title or slug is shown only when two documents share it.

✗ 2 menuItem documents share the slug “sourdough-loaf”
    Only one can own the address. menu-sourdough, menu-sourdough-old
! A query does not leave drafts out
    ./src/app/menu/[slug]/page.tsx:3  The menuItem query's filter does not leave drafts out. That is safe when the client asks for the published perspective, and leaks unpublished content if anything runs it with drafts.
! 2 menuItem documents are called “Seeded rye”
    Different addresses, same thing. menu-rye, menu-rye-copy
· A field your query asks for is missing on some documents
    ./src/app/menu/[slug]/page.tsx:3  allergens is missing on 28 of 40 documents. Fine if it is optional; a bug if the template assumes it.
✓ query-field-absent
✓ query-type-empty

4 to look at, 1 to fix first.
```

Copperhill Bakery's freelancer copied the sourdough loaf to make a seasonal version and renamed it, and the copy kept the loaf's address. Two documents now claim `/menu/sourdough-loaf`, and the menu page can show only one of them. The rye loaf was copied the same way, with a new address and the same name, so a search for "seeded rye" finds two pages.

| Finding                                                                   | Level          | What it usually means                                                                             |
| ------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `query-dupe-slug`: 2 `menuItem` documents share the slug `sourdough-loaf` | Fix this first | One of them cannot be reached. Delete the copy or give it its own slug.                           |
| `query-dupe-title`: 2 `menuItem` documents are called `Seeded rye`        | Fix soon       | Content was duplicated and not moved, which splits search results. It can also be two real pages. |

### How the matching works

- **A shared slug is a bug.** Slugs are compared exactly: `Sourdough-Loaf` and `sourdough-loaf` are two addresses. A shared title is a warning, because it can be two real pages. Titles are compared after trimming the spaces round them and ignoring case, so `Seeded rye` and `seeded Rye` are the same title.
- **Within one type.** A page and a post that both use the slug `about` are two addresses, so they are not reported. Only the types your queries read are looked at.
- **Published documents only.** A draft and the document it will become are one document, not a pair.
- **Documents with no slug, or no title, are left out of that part.** A type that has no slug field at all gives title findings only, and no error. Documents without a title are not reported either.
- **Reported once.** Documents that share both a slug and a title appear as the slug finding only.
- **The ids are the evidence**, sorted, ten at most and then `and 4 more`. Open them in the Studio by id.
- **Near matches are missed on purpose.** `Seeded rye` and `Seeded rye loaf` are two titles. The check is a plain rule, the same input gives the same findings, and nothing guesses.

### What `--dupes` reads

It is the one `query` option that reads more than counts. For each document type your queries name, one `GET` asks for exactly three things about each published document: its `_id`, its `slug.current` and its `title`. Nothing else is requested: no body, no image, no field you did not name. The token goes in a header, never in the address. The documents are grouped in memory and only the groups are kept, and the report shows a slug or a title only when two documents share it, never one that is unique. A title is text an editor wrote, so `--dupes` is the one option whose output shows editor-written text, and it is off unless you ask. It needs `SANITY_PROJECT_ID`, and a private dataset needs a token with the Viewer role: see [Private datasets](/docs/private-datasets#what-gaugeline-query-dupes-reads). A type with so many documents that the answer is larger than 5 MB stops the command with exit 2 and says so.

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
