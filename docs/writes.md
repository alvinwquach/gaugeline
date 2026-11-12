# What it can and can't write

It reads the R. It never writes the C, U or D — and here is what that means per protocol.

A fair question, asked early by anyone who has handed a tool credentials before: it says it checks your queries, so can it run them — and can it run the ones that change things?

**An audit trail written by the system it audits isn't one.** The thing that observes and the thing that changes are never the same process here. An agent can draft a mutation, a person approves it, and then your worker applies it with your credentials.

## Per protocol

| Protocol            | Read | Create, update, delete | What that means                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ---- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST                | yes  | never                  | Issues the reads it is told to and follows a documented cursor. It never sends a method that changes anything.                                                                                                                                                                                                                                                              |
| GraphQL             | yes  | parsed, never sent     | Asks for the schema with a `GET` (the query is in the address) and never a `POST`, with a read-only token when one is set. Mutations and subscriptions in your code are parsed and counted, and no request carries their text ([`gaugeline query --graphql`](query-check.md#graphql-the-same-way)). A server that takes `POST` only gets a schema file instead: `--schema`. |
| GROQ (Sanity)       | yes  | parsed, never sent     | Counts and shapes with a viewer token; your mutation code read from the repository the same way ([`gaugeline query --mutations`](query-check.md#mutations-checked-without-running-them), proved by [the promise test](#the-promise-test)).                                                                                                                                  |
| SQL                 | yes  | never                  | SELECT and catalogue reads only: counts, constraints, indexes, row-level security state, migration state. No DDL, no DML. A configured Postgres or Supabase source is read through a read-only transaction ([how](./connectors/postgres.md)).                                                                                                                               |
| Webhooks and queues | yes  | never                  | Reads delivery history and queue depth: `gaugeline platform --webhooks` reads Stripe's webhook endpoints and the events that were never delivered ([Paid downloads and delivery](delivery.md#webhooks-that-quietly-stopped)). It never enqueues, replays or retries on your behalf.                                                                                         |

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

## Local files it writes

"Read-only" on this page is a promise about systems: REST, GraphQL, GROQ, SQL, webhooks and queues are read and never changed. It is not a promise that nothing is ever written to your own computer. Three commands put files into your own repository, and the boundary is the same for all of them: they write local files only, and never touch a live system, a dataset or a payment provider.

| Command                  | What it writes                                                      | Where                                                              |
| ------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `--fix`                  | Edits to files that already exist, on a branch                      | Your repository                                                    |
| `gaugeline query --page` | Three new files: `queries.ts`, `types.ts` and `page.tsx`            | The folder `--out` names, inside the folder you ran the command in |
| `gaugeline query --save` | One baseline file of names: check ids, types, fields and file paths | The file `--save` names, inside the folder you ran the command in  |

The reports a check saves (`--save-requests`, `snapshot --out`, `plan --annotate`, `digest`) are files about a check, written where you name them, and none of them changes your code.

### --fix

One flag edits files that are already there, and only ever in your own repository: changes that are unambiguous and local to your files — an absolute share image, a missing width and height, alt text copied from the CMS. It edits files and opens a branch. It never touches a live system, a dataset or a payment provider.

```sh title=Terminal untested="Converted with a fixture in this page's own branch."
$ npx gaugeline yoursite.com --fix --branch fix/share-images
```

::: info
If a change is ambiguous, it stays a finding. The rule is that anything requiring judgement is drafted for a person, never applied.
:::

### --page

`gaugeline query --page --type resource --out "./src/app/resource/[slug]"` writes a starting route into a folder you name, from the shape of your published documents ([how it's written](query-check.md#starting-a-page-from-your-content)). It sends nothing to your dataset: the only requests are the `GET` counts that `--suggest` sends. The boundary is stated in code and proved by a test:

- **Inside the folder you ran it from.** `--out` is required. `../elsewhere`, an absolute path to another folder and a link that points out of the project are refused with exit 2 before anything is written.
- **Nothing is overwritten.** If any of the three files exists, nothing is written. `--force` replaces those three files, never a folder or a link, and leaves every other file in the folder alone.
- **All three files or none.** Every target is checked before the first write, and a write that fails part-way takes back what it wrote.
- **Every path is printed**, and nothing is created unless you pass `--page`. No git command is run.

The test (`packages/cli/src/__tests__/page.e2e.test.ts`) records every request, which are `GET` counts and nothing else, and records every file-system call, which writes only under `--out`.

### --save

`gaugeline query ./src --save before.json` keeps today's gaps so that a later run can show only the ones a restructure created ([how it works](query-check.md#before-a-restructure)). It asks the same `GET` counts as the plain run and nothing more. The file holds check ids, document types, field names and file paths, and never a token, a document or a field value. The writer is the one `--page` uses (`packages/cli/src/scaffold-write.ts`), and the boundary is the same:

- **Inside the folder you ran it from.** `../elsewhere.json`, an absolute path to another folder and a link that points out of the project are refused with exit 2 before anything is asked or written.
- **Nothing is overwritten.** If the file exists, nothing is written. `--force` replaces that file, never a folder or a link.
- **One file or none.** The target is checked before the first request, the folders it needs are made, and a write that fails removes what it made.
- **The path is printed**, and nothing is created unless you pass `--save`. `--against` only reads.

The test (`packages/cli/src/__tests__/query-baseline.test.ts`) fails if the file holds the token or any id, slug or title of a seeded dataset, and checks that a failed write leaves the folder as it was.

## Fixes you approve (hosted)

The hosted inbox will turn an approved fix into a draft in your own systems, never a live change ([ADR-0010](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0010-approve-then-act-writes.md)). A person approves each one; a job in your own worker applies it with your own key; the hosted service never holds a key that can write. A clinic's wrong opening hours become a Sanity draft your editor publishes; a missing redirect for a bar's old menu page becomes a pull request your developer merges.

| What it writes                | Where                  | What a person still does |
| ----------------------------- | ---------------------- | ------------------------ |
| A branch and a pull request   | Your GitHub repository | Reviews and merges       |
| A draft of one document       | Your Sanity dataset    | Reads and publishes      |
| An email draft to your client | Your own Gmail mailbox | Edits and presses Send   |

It never merges, publishes, sends or deletes. On GitHub it pushes one new branch and opens a pull request, and nothing else. **Protect your default branch first** (required reviews and required status checks): a token that can open a pull request can also merge one unless branch protection forbids it.

Approvals happen in [the inbox](hosted/inbox.md). The agent's database role cannot record an approval, a
client viewer cannot approve, a draft is decided once, and the approval row carries the SHA-256 of the
exact payload approved. The job only says which approval to look at: before it writes anything, your
worker reads that approval row itself and refuses unless the row exists, is an approval, is for this
draft, organisation, site and kind, hashes to the payload it was given, has not been declined or
withdrawn since, and is less than 72 hours old ([the checks, in order](hosted/writer.md#what-the-writer-checks-before-it-writes)).
