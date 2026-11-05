# What it can and can't write

It reads the R. It never writes the C, U or D — and here is what that means per protocol.

A fair question, asked early by anyone who has handed a tool credentials before: it says it checks your queries, so can it run them — and can it run the ones that change things?

**An audit trail written by the system it audits isn't one.** The thing that observes and the thing that changes are never the same process here. An agent can draft a mutation, a person approves it, and then your worker applies it with your credentials.

## Per protocol

| Protocol            | Read | Create, update, delete | What that means                                                                                                           |
| ------------------- | ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| REST                | yes  | never                  | Issues the reads it is told to and follows a documented cursor. It never sends a method that changes anything.            |
| GraphQL             | yes  | parsed, never sent     | Introspects the schema and runs queries with a read-only token. Mutations are checked against the schema and reported.    |
| GROQ (Sanity)       | yes  | parsed, never sent     | Counts and shapes with a viewer token; your mutation code read from the repository the same way.                          |
| SQL                 | yes  | never                  | SELECT and catalogue reads only: counts, constraints, indexes, row-level security state, migration state. No DDL, no DML. |
| Webhooks and queues | yes  | never                  | Reads delivery history and queue depth. It never enqueues, replays or retries on your behalf.                             |

## What it does instead of writing

- **Static checks on the write path.** A patch setting a field no type declares, a create missing a required field, a migration with no rollback, writes that aren't idempotent, two routes writing the same field.
- **The provider's own dry run.** Sanity mutations have dryRun, Stripe has test mode, Postgres has BEGIN … ROLLBACK. Driven from your CI with your credentials; the result comes back as a finding, not a change.
- **A scratch copy nobody serves.** Branch the database or copy the dataset, apply the change there, check the outcome, discard it. The only honest way to verify something destructive.

```sh title=Terminal
$ npx gaugeline query ./src --mutations      # parsed, never sent
$ npx gaugeline migrate ./migrations --dry-run
$ npx gaugeline compare staging production --schema
```

## The one exception: --fix

One flag writes, and only ever to your own repository: changes that are unambiguous and local to your files — an absolute share image, a missing width and height, alt text copied from the CMS. It edits files and opens a branch. It never touches a live system, a dataset or a payment provider.

```sh title=Terminal
$ npx gaugeline yoursite.com --fix --branch fix/share-images
```

::: info
If a change is ambiguous, it stays a finding. The rule is that anything requiring judgement is drafted for a person, never applied.
:::
