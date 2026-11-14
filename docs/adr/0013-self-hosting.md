# ADR-0013: Self-hosting waits for a hosted schema that has stopped moving

Status: proposed Date: 2026-11-12

**Waiting for the owner's decision; nothing is built.** This record proposes; it changes no code, no
flag and no line of CLAUDE.md. Branch `08/adr-later-work`, spec row G40 (the third of three records,
numbered 0011 to 0013 because 0002 to 0004 are taken).

## Context

Gaugeline already runs on your own machine and network: the command line, the local app on 127.0.0.1,
and CI templates. "Self-hosting" on the landing page's "Where it plugs in" means something larger: the
hosted product (sites, runs, findings, nightly runs, a drafts inbox) running on an operator's own
servers, for an agency that will not send findings to a third party. The spec's roadmap says: "Later. Only
after the hosted schema settles." The hosted schema (G34) and the runs API (G35) are not built yet.

The hosted stack, as the spec's stack table states it: Postgres on Supabase with row-level security,
Drizzle migrations as plain SQL files, Next.js with Route Handlers for a versioned `/api/v1`, `pg_cron`
and a queue for scheduled runs, and decisions in an append-only table.

### What a self-hosted install needs from that schema

| Need                                             | What it asks of the hosted schema                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create the database from nothing, and upgrade it | Migrations are plain ordered SQL files; a released one is never edited (G34 tests both)                                                                                  |
| Tenancy that cannot be bypassed                  | Row-level security policies live in the migrations, not in application code                                                                                              |
| Policies that run outside Supabase               | The policies reach the caller's identity through Supabase's own functions (uncited), so a plain Postgres needs those functions provided, or Supabase's self-hosted stack |
| An audit log nobody can rewrite                  | The append-only trigger is plain Postgres and travels with the migrations                                                                                                |
| Scheduled runs                                   | The schedule is data the worker reads, so a different scheduler can drive the same worker                                                                                |
| The command line posts to it                     | The runs API is a documented contract, and `--upload` takes the operator's base address                                                                                  |
| Nothing phones home                              | No licence check, billing or telemetry in the schema or the worker (ADR-0003)                                                                                            |

Every data source a self-hosted install touches, and whether it can be read without writing: the checked
sites (`GET` and `HEAD` through the fetcher, unchanged); the operator's own Postgres (it writes, which is
its own database, not a checked site); the runs the command line uploads (findings and evidence lines, no
page content).

## Decision

Self-hosting stays **later**, and until the trigger below the answer to "can I run it myself" is the
command line, CI and the Docker image, which already send nothing anywhere. When it is built:

- It is the same schema and the same API, not a second product: one set of migrations, one runs contract.
- **Postgres is the only dependency a self-hosted install adds**, and the identity function the policies
  call is the one place that differs from the hosted setup.
- The fetcher's rules do not change. A worker on the operator's network refuses private addresses unless
  the operator sets `--allow-private` for their own install, exactly as the command line does.
- Notifications still post only to the operator's own channels, from one file (ADR-0005).

## Alternatives

- **Ship a compose file with Supabase's own self-hosted stack now.** Lost: the schema is not built, so it
  would freeze an unsettled schema and promise support for it.
- **Plain Postgres with tenancy filters in application code.** Lost: the stack table chose tenancy in the
  database, because one forgotten filter shows one customer another's findings.
- **A single-file local mode (SQLite) for one person.** Lost: a second schema that drifts from the first
  and a new dependency; the command line already keeps one person's history.
- **Never self-host.** Not rejected, only the position until the trigger: it keeps the surface small.

## Cost

- Someone else's database and scheduler become something Gaugeline is asked about.
- Every migration has to work on hosted Supabase and on the operator's Postgres; the policies' identity
  function is a seam to keep stable.
- Upgrading an install is the operator's job, so a breaking schema change needs a migration guide.
- Whether the vendor's self-hosted stack is production-grade is uncited.

## What would change it

A schema unchanged for a quarter would bring it forward. A customer with a data-residency rule hosted
cannot meet would bring it forward. A schema still changing monthly would push it back again.

## Sources and what could not be read

Vendor documentation (Supabase self-hosting, `pg_cron`, Drizzle, Next.js self-hosting) could not be read
from this session: the network refused every vendor host, so those parts are **uncited**. Cited from this
repository: the spec's roadmap table and stack table, G34 to G36 (migrations as plain SQL, a versioned API,
nightly runs), ADR-0001, ADR-0003 and ADR-0005, and `docs/ci.md` for the Docker run.

## Enforced by

Nothing new, because nothing is built. What already holds:

- `packages/core/src/fetcher.ts` (the address rule and `GET`/`HEAD` only, wherever the fetcher runs)
- `packages/cli/src/__tests__/no-phone-home.test.ts` (a run contacts only the checked site)
- `packages/core/src/__tests__/post-boundary.test.ts` (nothing but the allowed files sends a `POST`)
- `docs/ci.md` (the run-it-yourself paths that exist today)

## Build when

All three, which a person can check:

1. G30 (the Docker image), G34, G35 and G36 have merged.
2. No migration has changed an existing table for 90 days (the git history of the migrations folder
   shows it).
3. Two organisations have asked in writing, each saying why the hosted tier cannot serve them. The
   numbers are this record's proposal; the owner may change them.
