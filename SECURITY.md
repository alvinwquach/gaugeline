# Security policy

## Supported versions

Security fixes go into the latest minor release. Upgrade to it to get them.

## How to report a problem privately

Please do not open a public issue.

1. **Preferred:** report it privately on GitHub, from the repository's **Security** tab, with
   "Report a vulnerability". Only the maintainers see it.
2. Or email the address on the [Security page](https://claude.ai/artifact/CuXxFEDG9Me8CTTfSkSCNt)
   ("Found a security problem?"). It is not repeated here so there is only one copy to keep current.

## What to include

- The version (`gaugeline --version`), your Node version and operating system.
- What you did, what happened, and what you expected, with the smallest steps that show it.
- Why it matters: what an attacker could read, change or reach.
- Remove keys, webhook addresses and private URLs from anything you send.

## What to expect back

An acknowledgement within 3 working days, and an assessment within 10 working days saying whether
we agree it is a problem and when a fix is likely. We will credit you in the release notes unless
you ask us not to.

## In scope

The `gaugeline` CLI, the local app it opens (`gaugeline open`), and the packages published from this
repository. Gaugeline's promises are written down as decision records: it is read-only
([ADR-0001](docs/adr/0001-read-only-by-construction.md)), never calls a model to find problems
([ADR-0002](docs/adr/0002-plain-rules-no-model-calls.md)), and sends nothing anywhere you did not
configure ([ADR-0003](docs/adr/0003-no-telemetry-nothing-sent.md)). A way to break one of those is in
scope.

## The hosted app's database (in progress)

The hosted app (`apps/hosted`, not released) keeps each organisation's sites, runs and findings apart with
row-level security in the database, not with filters in application code. Decisions on proposed changes
and consent to probing checks are append-only: a trigger refuses to change or remove them for every
role. No page content and no keys are stored. A way for one organisation to read or write another's rows,
for a client viewer to see a site that is not theirs, or to rewrite a decision or consent record is in
scope. See [Hosted: data model and tenancy](docs/hosted/data-model.md).

## Please do not

Test against sites you do not own or have permission to test. Gaugeline's fixture sites
(`packages/fixtures`) run on your own machine and are the place to reproduce a problem.
