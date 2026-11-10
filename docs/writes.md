# What it can and can't write

It reads the R. It never writes the C, U or D — and here is what that means per protocol.

A fair question, asked early by anyone who has handed a tool credentials before: it says it checks your queries, so can it run them — and can it run the ones that change things?

**An audit trail written by the system it audits isn't one.** The thing that observes and the thing that changes are never the same process here. An agent can draft a mutation, a person approves it, and then your worker applies it with your credentials.

## Per protocol

| Protocol            | Read | Create, update, delete | What that means                                                                                                                                                                                                                                                                     |
| ------------------- | ---- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST                | yes  | never                  | Issues the reads it is told to and follows a documented cursor. It never sends a method that changes anything.                                                                                                                                                                      |
| GraphQL             | yes  | parsed, never sent     | Introspects the schema and runs queries with a read-only token. Mutations are checked against the schema and reported.                                                                                                                                                              |
| GROQ (Sanity)       | yes  | parsed, never sent     | Counts and shapes with a viewer token; your mutation code read from the repository the same way ([`gaugeline query --mutations`](query-check.md#mutations-checked-without-running-them), proved by [the promise test](#the-promise-test)).                                          |
| SQL                 | yes  | never                  | SELECT and catalogue reads only: counts, constraints, indexes, row-level security state, migration state. No DDL, no DML. A configured Postgres or Supabase source is read through a read-only transaction ([how](./connectors/postgres.md)).                                       |
| Webhooks and queues | yes  | never                  | Reads delivery history and queue depth: `gaugeline platform --webhooks` reads Stripe's webhook endpoints and the events that were never delivered ([Paid downloads and delivery](delivery.md#webhooks-that-quietly-stopped)). It never enqueues, replays or retries on your behalf. |

## What it does instead of writing

- **Static checks on the write path.** A patch setting a field no type declares, a create missing a required field, a migration with no rollback, writes that aren't idempotent, two routes writing the same field.
- **The provider's own dry run.** Sanity mutations have dryRun, Stripe has test mode, Postgres has BEGIN … ROLLBACK. Driven from your CI with your credentials; the result comes back as a finding, not a change.
- **A scratch copy nobody serves.** Branch the database or copy the dataset, apply the change there, check the outcome, discard it. The only honest way to verify something destructive.

```sh title=Terminal untested="Needs a folder of source files and a schema file. docs/query-check.md runs the same command in an invented repository, and packages/cli/src/__tests__/query-docs.test.ts compares its output."
$ npx gaugeline query ./src --mutations      # parsed, never sent
$ npx gaugeline migrate ./migrations --dry-run
$ npx gaugeline compare staging production --schema
```

## The promise test

"Parsed, never sent" is proved, not asserted, and the proof does not depend on a reviewer reading the code carefully.

- **The module cannot send.** The code that reads mutations, `packages/core/src/query/mutations.ts`, may not import the fetcher, the Sanity reader, `node:http`, `node:https`, `node:net` or any HTTP client, directly or through another module. A test walks its imports and fails the build if one appears, so the promise holds after the next refactor too.
- **A network that throws.** A test runs `gaugeline query --mutations` over a repository that is full of writes with `fetch`, `node:http`, `node:https` and `node:net` replaced by functions that throw, and with a transport that fails the test if it is called at all. It makes zero calls, and the command still exits 0.
- **A source file is read, never run.** A test reads a file that throws on its first line and would send a patch on its second. The compiler parses it; nothing is evaluated.
- **No request carries a mutation, even when a dataset is read.** With `SANITY_PROJECT_ID` set too, every request that is made is a `GET` for counts, and none of them mentions a write.

The tests are `packages/core/src/query/__tests__/mutations.test.ts` and `packages/cli/src/__tests__/query-mutations.test.ts`. The cost is that `--mutations` cannot fetch your schema itself, so you give it a schema file.

## The one exception: --fix

One flag writes, and only ever to your own repository: changes that are unambiguous and local to your files — an absolute share image, a missing width and height, alt text copied from the CMS. It edits files and opens a branch. It never touches a live system, a dataset or a payment provider.

```sh title=Terminal untested="Converted with a fixture in this page's own branch."
$ npx gaugeline yoursite.com --fix --branch fix/share-images
```

::: info
If a change is ambiguous, it stays a finding. The rule is that anything requiring judgement is drafted for a person, never applied.
:::
