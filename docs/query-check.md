# Checking your queries

GROQ, GraphQL and the mutations you ship — checked against the content that actually exists, not just the schema.

Sanity's TypeGen compares your queries with your schema at build time, which catches a field you spelled wrong. It can't tell you that the field exists in the schema and is empty on every document you've ever published. That gap is where restructures go wrong.

```sh title=Terminal untested="Needs a Sanity project and a folder of source files. packages/cli/src/__tests__/query-docs.test.ts runs the same command against an invented dataset and compares the output with the block under What it reports."
$ SANITY_PROJECT_ID=abc123 SANITY_TOKEN=… npx gaugeline query ./src
```

::: info What works today
`gaugeline query <folder>` reads the GROQ in your repository and lists each query with its file and line. With `SANITY_PROJECT_ID` set it also asks your dataset how many documents of each type exist and how many have each field, and reports the four findings under [What it reports](#what-it-reports). Without it the command makes no request and needs no token. With `--dupes` it also names documents that share a slug or a title, and with `--mutations` it reads the writes in your code and checks their shapes against your schema file without sending any of them. With `--graphql` it checks your GraphQL against the schema and the content instead. With `--suggest` it writes a starting query from the content, and with `--page` it writes a starting route (queries, types and page) into a folder of your project.
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

The other direction: instead of checking a query you wrote, have it written from the content you have. Northfield Coaching's library page needs a query for its `resource` type, and the freelancer building it would rather start from what the dataset holds than from a blank file. `--suggest --type resource` takes the type's fields from your schema, counts how many of the newest published resources have each one, and prints a starting query.

```sh title=Terminal untested="Needs a folder of source files, a schema file and a dataset, and the docs runner points every example at a fixture website. packages/cli/src/__tests__/query-docs.test.ts runs the same command in the invented Northfield repository (packages/fixtures/repo-gql, with its schema.json) against an invented dataset of twelve published resources, and compares the output with the block below."
$ SANITY_PROJECT_ID=northfield npx gaugeline query ./src --suggest --type resource
```

```text title=Output
// resource, written from 12 published documents
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
// This describes what your content has today, not what your page needs.
// Delete what the page does not use: every field you ask for is data you pay to fetch and render.
```

- Slugs unwrapped, references dereferenced one level, images and files resolved to URLs
- Fields that aren't on every document noted in a comment, with how common they are, and the plain ones wrapped in `coalesce` so the page gets an empty value instead of `null`
- Drafts excluded, newest first

::: warning
It describes what your content has today, not what your page needs. Read it, delete what the page doesn't use, and keep the query small: every field you ask for is data you pay to fetch and render.
:::

### How the query is written

- **Names and kinds from your schema, counts from your dataset.** The fields of the type, and whether each is a string, a slug, a reference, an image, a file, an array, an object or Portable Text, come from the schema file: `npx sanity schema extract` writes `schema.json`, and `--schema ./path/schema.json` points at another one. Without `--schema` it looks for `./schema.json` where you ran the command, then `schema.json` in the folder you named, as `--mutations` does, and stops with exit 2 if it finds neither. How common each field is comes from count queries over your published documents, the way [the counts above](#how-the-counting-works) work. No document is requested.
- **From a sample, not every document.** The counts are over the newest 50 published documents of the type, in one `GET`, and the first line says how many that was (`written from 12 published documents` here, because the type has 12). A type with 40,000 documents would cost a lot to answer what 50 recent ones answer well enough to draft from. The catch is that a field used only on old documents can be missed.
- **Plain rules, not a model.** The query is written from the field names, kinds and counts, and the same schema and counts give the same text. Nothing is sent to an AI service.
- **Field order is `_id`, then the order your schema declares the fields.** A field whose name can't be written into a query plainly (Sanity's own rule is letters, digits and underscores; a word GROQ reads as something else, such as `in` or `match`, also counts) is left out, and a comment says how many.
- **A field that is on none of the documents is left out**, with a comment saying so: it is in the schema and nobody has filled it in, so asking for it would only fetch `null`.
- **What gets `coalesce`.** A string, number, boolean, slug, array or Portable Text field that is on fewer documents than were counted: `""`, `0`, `false` or `[]`. An object, image, file or reference is left to be `null`, because an empty stand-in would hide that it is missing. A field that is on every document gets neither a comment nor a `coalesce`.
- **A nested field is compared with its parent.** `heroImage` can be on every document while its `alt` is on half: `alt` is always written with `coalesce(alt, "")`, and any other optional field inside an object or an array of objects gets its own comment, counted against the documents that have the object or the items in the array. Nesting is followed three levels down.
- **A field the schema lets be two kinds.** If `credit` is allowed to be a string or an object, it is written plainly with a comment naming both kinds, because no one query shape fits both.
- **A reference is dereferenced one level**, as `_id`, `title` and `slug`. Gaugeline doesn't read the referenced documents, so it can't know their fields: change that line to what the page shows.
- **It prints and writes nothing.** The query goes to the terminal so you read it before you use it. Redirect it (`> query.groq`) if you want a file. The folder you name is checked to exist and is not read.
- **It needs `SANITY_PROJECT_ID`** (and `SANITY_TOKEN`, with the Viewer role, for a private dataset). A type with no published documents is exit 2 and prints `Nothing of type topic exists`, with no query. A type the schema doesn't declare is exit 2 and lists the types it does. `--suggest` without `--type` is exit 2 and prints the usage.

### What it can't see

The schema says what a field is allowed to be, and the counts say how many documents have it. Together they don't say everything the documents hold, and the query is only as current as your schema file.

- A field that exists on old documents but is no longer in the schema is not in the query.
- A field the schema types one way and some documents hold another way is written as the schema says.
- Field order follows the schema, not the order a document happens to list its fields.
- A schema file that is older than the dataset gives an older query: run `npx sanity schema extract` again first.

This is deliberate. GROQ has no function that lists the field names of a document, so the only other way to learn them is to receive the documents, and `--suggest` never asks for one. What it sends: [Privacy and safety](/docs/privacy#written-queries-gaugeline-query-suggest).

## GraphQL, the same way

If the site reads its content over GraphQL, `--graphql` checks that instead of GROQ. Sanity can serve a GraphQL API generated from your schema, and any other GraphQL endpoint works too. The command reads your `.graphql` and `.gql` files and your `gql` tags, asks the endpoint for its schema, and reports fields that don't exist. For a Sanity endpoint it then counts the same document types in the dataset, which introspection alone can't do: a schema says a field may exist, and only a count says it does.

Northfield Coaching is a one-coach business with a free resource library, built by a freelancer on Sanity and Next.js. Someone renamed `author` to `coach` in the Studio, and the query for the library page still asks for `author`. The summary field exists in the schema, and nobody has filled it in on any resource.

```sh title=Terminal untested="Needs a folder of source files and a GraphQL endpoint, and the docs runner points every example at a fixture website. packages/cli/src/__tests__/query-docs.test.ts runs the same command in the invented Northfield repository (packages/fixtures/repo-gql), against recorded answers, and compares the output with the block below."
$ SANITY_PROJECT_ID=northfield npx gaugeline query . --graphql
```

```text title=Output
GraphQL  https://northfield.api.sanity.io/v1/graphql/production/default
Read 3 queries and 1 fragment in 5 files: 17 fields checked against the schema.
Found 1 mutation and 1 subscription. They were parsed and counted, and never sent.

Could not read 1 document:
  src/lib/dynamic.ts:5  concatenated: built from something other than a gql template (an interpolated string or call), so it cannot be read from the file

Counted the published documents of 2 types in the dataset: one request each, counts only.

✗ author isn't in the schema
    allResource.author · gql/resources.graphql:1
✗ nickname isn't in the schema
    Resource.coach.nickname · src/lib/fragments.ts:4
✗ A field your query asks for is on no document
    src/lib/queries.ts:5  summary doesn't exist on any resource: 0 of 9 documents have it. The field was probably renamed, so what shows it renders empty.
✓ query-type-empty
✓ query-field-partial
✓ query-no-drafts-filter

3 to look at, 3 to fix first.
```

The first line is the endpoint that was asked, so you can see which API the result is about. The first two findings come from the schema (`graphql-field-not-in-schema`, "Fix this first"): `author` and `nickname` are not fields of `Resource` and `Coach`. The third comes from the content: `summary` is in the schema, and no published resource has it.

- **No endpoint.** `--graphql` on its own asks Sanity's GraphQL API for your project, `https://<projectId>.api.sanity.io/v1/graphql/<dataset>/default`, built from `SANITY_PROJECT_ID` and `SANITY_DATASET` (`production` when unset). `--graphql https://example.com/graphql` asks that address instead.
- **How it asks.** The schema is one `GET` with the introspection query in the address, which is how GraphQL over HTTP sends a query that way, through the same fetcher as everything else Gaugeline requests. It never sends a `POST`. A token goes in an `Authorization` header and never in the address: `SANITY_TOKEN` for Sanity's own address and `GRAPHQL_TOKEN` for any other, so your Sanity token is never offered to a server that isn't Sanity's.
- **If the endpoint won't answer a GET.** Some servers take `POST` only, and some turn introspection off. The command stops with exit code 2 and says so, and it does not try another way. Give it the schema as a file instead: `--schema ./schema.graphql` takes an SDL file or the JSON that an introspection query returned, and asks no endpoint at all.
- **What it reads.** `.graphql` and `.gql` files, and `gql` and `graphql` tagged templates in `.ts`, `.tsx`, `.js`, `.jsx` and `.mjs` files, under the same skips as for GROQ. A fragment is resolved by name across files, and one interpolated into a template (`${COACH_FIELDS}`) is resolved when it is a `gql` template too. A template built from a string or a call, a document that doesn't parse and a fragment nobody defines are listed under "Could not read", with the file and line. A fragment no query uses is still checked, on the type it names.
- **What it finds.** A field that isn't on the type it is asked on, with the path from the query and the file and line the query or fragment starts on. A field on an interface or a union counts as there when the interface has it or any type it can be has it. A field whose parent was already reported is not reported again, and a type the schema doesn't have is left alone, because there is nothing to compare with. Arguments, variables and nullability are not checked.
- **The content step.** For a Sanity endpoint, a root field that returns a document type (`allResource`, `Resource(id: ...)`) is counted in the dataset like a GROQ query: the type is the GraphQL type's name with a small first letter (`BlogPost` is `blogPost`), a reference reads as `coach->name` and a list of objects as `sections[].heading`, so the count lands on the field itself. The three count findings under [What it reports](#what-it-reports) apply. A query that leaves drafts out is not reported, because the API serves published documents. With `--schema` and no endpoint it runs when `SANITY_PROJECT_ID` is set. For any other endpoint it is skipped, and the output says so.
- **Mutations and subscriptions.** They are parsed, counted and never sent. The line under the endpoint says how many were found, and none of their text reaches a request: the introspection query is a constant. The checks are for queries, so their fields aren't compared with the schema.

`--graphql` is its own run: it can't be combined with `--dupes` or `--mutations`, and it needs the same TypeScript as the rest of the command.

```sh title=Terminal untested="Needs a folder of source files and a schema file. packages/cli/src/__tests__/query-docs.test.ts runs the same command in the invented Northfield repository and compares the output with the block below."
$ npx gaugeline query . --graphql --schema ./schema.graphql
```

```text title=Output
GraphQL  schema from ./schema.graphql
Read 3 queries and 1 fragment in 5 files: 17 fields checked against the schema.
Found 1 mutation and 1 subscription. They were parsed and counted, and never sent.

Could not read 1 document:
  src/lib/dynamic.ts:5  concatenated: built from something other than a gql template (an interpolated string or call), so it cannot be read from the file

SANITY_PROJECT_ID is not set, so the queries were not compared with your content. Set it (and SANITY_TOKEN, with the Viewer role, for a private dataset) to count the documents.

✗ author isn't in the schema
    allResource.author · gql/resources.graphql:1
✗ nickname isn't in the schema
    Resource.coach.nickname · src/lib/fragments.ts:4

2 to look at, 2 to fix first.
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

The same shape that writes a query can scaffold the route around it. The point isn't saving keystrokes: it's that the generated page already satisfies the checks people fail most, an image that carries its alt text and its size, a canonical address and share tags.

Northfield Coaching keeps its free resource library in Sanity and its site in Next.js, and the freelancer building the resource page runs this from the root of the project, with the schema file `sanity schema extract` wrote beside it:

```sh title=Terminal untested="Needs a project folder with a schema file, a dataset, and a folder to write to, and the docs runner points every example at a fixture website. packages/cli/src/__tests__/query-docs.test.ts runs the same command in a temporary copy of the invented Northfield repository (packages/fixtures/repo-gql) against an invented dataset of twelve published resources, and compares the output and the three files below with what it writes."
$ SANITY_PROJECT_ID=northfield npx gaugeline query --page --type resource --out "./src/app/resource/[slug]"
```

```text title=Output
Wrote 3 files to ./src/app/resource/[slug] from 12 published resource documents
  ./src/app/resource/[slug]/queries.ts
  ./src/app/resource/[slug]/types.ts
  ./src/app/resource/[slug]/page.tsx
```

| File         | What's in it                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queries.ts` | List, detail and slug queries. Drafts excluded, fields that exist on your documents.                                                                                                        |
| `types.ts`   | A TypeScript interface. Fields missing on some documents are optional, so the compiler makes you guard them.                                                                                |
| `page.tsx`   | `generateStaticParams`, `generateMetadata` with the canonical and share tags, an image carrying the editor's alt text with width and height set, references linked, Portable Text rendered. |

`queries.ts` for the twelve resources:

```ts title=queries.ts
import groq from "groq";

// Written by gaugeline query --page from 12 published resource documents.
// publishedAt is present on 50% of the sample
// gatedFile is present on 33% of the sample

// Every published document, newest first, with what a list shows.
export const resourceListQuery = groq`*[_type == "resource" && !(_id in path("drafts.**"))] | order(_updatedAt desc) {
  _id,
  title,
  "slug": slug.current,
  summary,
  heroImage{ "url": asset->url, "alt": coalesce(alt, ""), "width": asset->metadata.dimensions.width, "height": asset->metadata.dimensions.height }
}`;

// The address of every published document, for generateStaticParams.
export const resourceSlugsQuery = groq`*[_type == "resource" && !(_id in path("drafts.**")) && defined(slug.current)].slug.current`;

// One document by its address, with every field.
export const resourceQuery = groq`*[_type == "resource" && !(_id in path("drafts.**")) && slug.current == $slug][0] {
  _id,
  title,
  "slug": slug.current,
  summary,
  topic->{ _id, title, "slug": slug.current },
  body,
  heroImage{ "url": asset->url, "alt": coalesce(alt, ""), "width": asset->metadata.dimensions.width, "height": asset->metadata.dimensions.height },
  tags[],
  "publishedAt": coalesce(publishedAt, ""),
  gatedFile{ "url": asset->url, "name": asset->originalFilename, "size": asset->size }
}`;
```

`types.ts`: `publishedAt` is on 6 of the 12 documents, so it is optional; `title` is on all 12, so it is not.

```ts title=types.ts
import type { PortableTextBlock } from "@portabletext/react";

// Written by gaugeline query --page from 12 published resource documents.
// A field with a ? is missing on some of them, so the compiler makes you guard it.
export interface Resource {
  _id: string;
  title: string;
  slug: string;
  summary: string;
  topic: { _id: string; title: string | null; slug: string | null } | null;
  body: PortableTextBlock[];
  heroImage: {
    url: string | null;
    alt: string;
    width: number | null;
    height: number | null;
  } | null;
  tags: string[];
  publishedAt?: string; // on 6 of the 12 documents
  gatedFile?: { url: string | null; name: string | null; size: number | null } | null; // on 4 of the 12 documents
}

export type ResourceListItem = Pick<Resource, "_id" | "title" | "slug" | "summary" | "heroImage">;
```

::: details page.tsx

```tsx title=page.tsx
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PortableText } from "@portabletext/react";
import { client } from "@/sanity/lib/client";
import { resourceQuery, resourceSlugsQuery } from "./queries";
import type { Resource } from "./types";

// Written by gaugeline query --page from 12 published resource documents.
// The canonical and share addresses below are paths, and Next.js resolves them against
// metadataBase: set it in your root layout (app/layout.tsx), or the build stops and says so.
// BASE_PATH is where this folder is served on your site; change it if it is not /resource.
const BASE_PATH = "/resource";

type Props = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  const slugs = await client.fetch<string[]>(resourceSlugsQuery);
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const doc = await client.fetch<Resource | null>(resourceQuery, { slug });
  if (!doc) return {};
  const title = doc.title;
  const description = doc.summary;
  const path = `${BASE_PATH}/${slug}`;
  const image = doc.heroImage;
  const images = image?.url
    ? [
        {
          url: image.url,
          alt: image.alt,
          width: image.width ?? undefined,
          height: image.height ?? undefined,
        },
      ]
    : undefined;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "article", url: path, title, description, images },
    twitter: { card: images ? "summary_large_image" : "summary", title, description, images },
  };
}

export default async function ResourcePage({ params }: Props) {
  const { slug } = await params;
  const doc = await client.fetch<Resource | null>(resourceQuery, { slug });
  if (!doc) notFound();
  return (
    <article>
      <h1>{doc.title}</h1>
      <p>{doc.summary}</p>
      {doc.topic?.slug ? (
        <p>
          <Link href={`/topic/${doc.topic.slug}`}>{doc.topic.title ?? doc.topic.slug}</Link>
        </p>
      ) : null}
      <PortableText value={doc.body} />
      {doc.heroImage?.url && doc.heroImage.width && doc.heroImage.height ? (
        <Image
          src={doc.heroImage.url}
          alt={doc.heroImage.alt}
          width={doc.heroImage.width}
          height={doc.heroImage.height}
        />
      ) : null}
      <ul>
        {doc.tags.map((item, i) => (
          <li key={`${i}-${item}`}>{item}</li>
        ))}
      </ul>
      {doc.publishedAt ? <p>{doc.publishedAt}</p> : null}
      {doc.gatedFile?.url ? (
        <p>
          <a href={doc.gatedFile.url}>{doc.gatedFile.name ?? "Download"}</a>
        </p>
      ) : null}
    </article>
  );
}
```

:::

::: info
Useful when building from scratch, and more useful during a restructure: generate against the migrated content and the scaffold reflects what actually arrived, including the fields that came over empty.
:::

It is not a page builder. There's no design in it, no layout opinions, and no component library. Treat it as the wiring: delete the fields this page doesn't render, then check the result with `npx gaugeline yoursite.com/resource/<slug>`.

### What the page assumes

The files are templates filled from the shape, with no model involved, so the same shape gives the same files. They assume things about your project, and say so in the file where it matters:

- **Next.js 15 or newer with the App Router.** `params` is a promise there, so the page awaits it. `generateStaticParams` and `generateMetadata` are the [Next.js functions](https://nextjs.org/docs/app/api-reference/functions/generate-static-params) of those names.
- **`groq`, `@portabletext/react` and a Sanity client at `@/sanity/lib/client`**, which is where `sanity init` puts it for a Next.js project. Install the two packages (`npm install groq @portabletext/react`) or change the imports. The client only needs a `fetch(query, params)` method.
- **`metadataBase` set in your root layout.** The canonical and share addresses are paths (`/resource/<slug>`), and Next.js builds the full address from `metadataBase`; without it the build stops and says so, which is better than a canonical that is wrong. `BASE_PATH` at the top of `page.tsx` is where the folder is served: change it if the folder is not named after the type.
- **The folder is named `[slug]`.** The page reads `params.slug`. A folder with another name is used as you gave it, and a note on stderr says what to rename.
- **A slug field makes the address.** `slug` if the type has one, else the first slug field, else the document id (and a comment says so).
- **Image size comes from the asset.** The detail query asks for `asset->metadata.dimensions`, and the image is shown only when it has a url, a width and a height, with the editor's alt text, or an empty one when none was written.
- **References link to `/<field name>/<slug>`**, because the type a reference points at is not read. Change the path to where those pages live.

### How the files are written

- **Local files only.** `--page` writes into a folder you name, inside the folder you ran it from. It sends nothing to your dataset, runs no git command, and writes nowhere else: see [What it can and can't write](/docs/writes#local-files-it-writes).
- **`--out` is required**, and must be the current folder or one inside it. `../elsewhere`, an absolute path to another folder, and a link inside the project that points out of it are refused with exit 2 and nothing written. The folder is created when it is missing.
- **It never overwrites.** If any of the three files already exists, nothing is written, and the message names the files. `--force` replaces those three files, and never a folder or a link of that name; any other file in the folder is left alone.
- **All three files or none.** Every target is checked before the first write. If a write fails part-way (a read-only folder, a full disk), the files already written are removed, a file `--force` replaced is put back, and the folders this run created are removed, so the folder is as it was.
- **Every path is printed.** The first line says how many files and how many documents the shape was read from (at most the newest 50); the lines after it are the paths.
- **What it reads is what `--suggest` reads.** Field names and kinds from the schema file, counts from your dataset, one `GET`, no document. A type with no published documents or one the schema doesn't declare is exit 2, and creates nothing, not even the folder. `--page` without `--type` or without `--out` is exit 2 and prints the usage.
- **It describes today's content.** The gaps in [What it can't see](#what-it-can-t-see) apply to the files too. A field that exists only in old documents is not in them, and the list query asks for the title, the address, the description and the first image, not every field.

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
