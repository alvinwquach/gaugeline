# Migration guides, Since badges and the changelog feed

Every release has three docs requirements. Each one is checked by a test, so a pull request cannot
skip it.

## A migration guide for every breaking change

A change is **breaking** when its changeset is a **major** bump, or when any line of the changeset
starts with `BREAKING:`. Before 1.0 a breaking change is usually a minor bump, so the `BREAKING:` line
is how you mark it.

A breaking changeset must say where its guide is, with a `Migration: <slug>` line. The slug is
lowercase words joined by hyphens, and it resolves to `docs/migrations/<slug>.md`:

```md title=".changeset/drop-old-flag.md"
---
"gaugeline": minor
---

BREAKING: The --menu-url flag is now --menu.
Migration: menu-flag
```

The guide is a docs page. Add it to the "Migrations" group in `docs/nav.ts` (`pnpm docs:check` tells
you if you forget). Write it for the person who is about to be hurt by the change: what they will see,
what to change, and one worked example from client work. For the rename above, that is a freelancer who
runs Gaugeline for a pop-up bar's ordering page in a nightly job, with the old flag in the workflow
file and the new one next to it.

`pnpm docs:changelog` then does the rest: the release entry in `docs/changelog.md` is marked
**Breaking** and links the guide, the guide is listed at the top of the changelog, and the same link
is in the Atom feed.

The test (`scripts/__tests__/migrations.test.ts`) reads the pending changesets, the released
`packages/cli/CHANGELOG.md` and the backfilled `docs/changelog.data.json`. It fails when a breaking
entry has no `Migration:` line, names a guide that does not exist, or names something that is not a
plain slug. Released history is checked too, so a guide cannot be deleted after the release.
`(internal)` changesets are never breaking. The first guide is [Node 22 and newer](/docs/migrations/node-22).

## "Since vX" on every check

The checks reference shows which version added each check. You do nothing for a new check beyond its
changeset:

- A check that no release has stamped shows the **next version**: the current version of `gaugeline`
  moved by the largest pending changeset (a minor changeset after 0.1.0 shows 0.2.0). It is worked out
  when the docs are built, so it is never committed and never goes stale.
- `pnpm version` (the Release pull request) runs `scripts/check-since.ts --release` after Changesets,
  which writes the real version into `docs/check-since.lock.json`. From then on that entry never
  changes. `pnpm since --base origin/main` fails when it does.

## The changelog feed

`pnpm docs:changelog` also writes `docs/public/changelog.atom`, an Atom 1.0 feed with one entry per
released version. Entry ids look like `urn:gaugeline:changelog:0.2.0` and never change; links use the
docs address, which is `DOCS_URL` when set and `docs/site.ts` otherwise. `pnpm docs:changelog --check`
(in CI) fails if the feed is out of step.

A freelancer who looks after a handful of sites can add the feed to a reader and see a breaking change,
with its migration guide, before the next nightly run fails.
