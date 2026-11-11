# Backups: know when a client's content was last backed up

A client's content or database gets wiped, by a bad import, a deleted dataset or a mistaken migration, and
the first question is "when was the last backup?". Most freelancers do not know until that moment.
`gaugeline backups` reads the backup status where a platform documents a read-only way to ask, looks at
the dated export files you already write, and tells you when the newest one is old, when backups were
never switched on, and when the latest export is far smaller than the one before.

It only reads. It never starts a backup or an export, never restores anything, and the only requests are
`GET`. An export file is listed by name, size and time and is never opened.

```sh
npx gaugeline backups marlowe-bar.com
```

## What it reads

| What                          | How                                                                                                                                 | Needs a key?            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Supabase backups and recovery | One `GET` of the project's backups on the Management API: daily backups on or off, point-in-time recovery on or off, the newest one | `SUPABASE_ACCESS_TOKEN` |
| Sanity dataset backups        | One `GET` of the dataset's backups, where the plan has them                                                                         | `SANITY_TOKEN`          |
| A folder of dated exports     | The files directly in a folder on this computer (or a synced bucket): name, size and time. Never opened                             | No                      |
| Everything else               | A line to check by hand in the report and in the handoff, never a guess                                                             | No                      |

Anything a platform does not expose, or a token may not read, is listed as "could not be checked" with the
reason. It is never counted as a pass and never as a finding.

## Example: a bar with bookings in Supabase

Marlowe Bar is an invented client: a bar whose bookings live in a Supabase project and whose menu data a
nightly job exports to a folder. You keep the settings next to the site, and a Supabase access token in
the environment of the machine that runs the check (the token is yours, not the client's).

```json title=gaugeline.backups.json
{
  "supabase": { "projectRef": "abcdefghijklmnopqrst" },
  "exports": [{ "name": "menu", "folder": "backups/menu" }]
}
```

```sh title=Terminal untested="Runs the built command against recorded responses for an invented bar. packages/cli/src/__tests__/backups-docs.test.ts runs it (the docs runner points commands at a fixture site, and this one reads a platform API and a folder) and compares the output with the block below."
$ npx gaugeline backups marlowe-bar.example
```

```text title=Output
Backups for marlowe-bar.example
  Supabase project abcdefghijklmnopqrst: daily backups on, point-in-time recovery off. Newest backup 12 days ago (30 Oct 2026), over the 7-day limit.
  Export "menu" (backups/menu): 3 files, newest menu-2026-11-10.json.gz, 12 KB, dated 1 day ago (10 Nov 2026), the one before 94 KB (far smaller).

✗ No recent backup
    Supabase project abcdefghijklmnopqrst: the newest backup was 12 days ago (30 Oct 2026); more than 7 days is flagged
! The latest export is far smaller than the one before
    Export "menu" (backups/menu): menu-2026-11-10.json.gz is 12 KB, under 50% of menu-2026-11-09.json.gz before it (94 KB)

2 to look at, 1 to fix first.
```

The first finding is the one to tell the client about: daily backups are on, but the job stopped on
30 October, so everything since is unprotected. The second is the kind of thing nobody notices until a
restore: the menu export shrank from 94 KB to 12 KB overnight, which is usually a table that was skipped or
a job that ran out of space.

## Example: a pop-up on Wix

Ember Pop-up Kitchen is an invented pop-up on Wix. Wix has no backup status Gaugeline can read, and there
is no key to set, so nothing is asked and the output is a checklist, not a verdict.

```sh title=Terminal untested="Runs the built command against recorded responses for an invented pop-up. packages/cli/src/__tests__/backups-docs.test.ts runs it and compares the output with the block below."
$ npx gaugeline backups ember-popup.example
```

```text title=Output
Backups for ember-popup.example
  No backup source is set up, so no backup status was read.
Check by hand
  [ ] Wix: Gaugeline cannot read Wix's backup status. Open its dashboard and check that a copy of the site (its version history or an export) exists and when it was last made, and keep an export of the content yourself.

? no-recent-backup could not be checked: no backup source is set up: name a Supabase project under supabase in gaugeline.backups.json and set SUPABASE_ACCESS_TOKEN, set SANITY_TOKEN and SANITY_PROJECT_ID for Sanity, or list an export folder under exports (/)

Nothing to look at.
```

The same lines appear on the owner's checklist in [the handoff report](handoff.md), under what to ask the
person who built the site for, so the client knows where their backups are before they need one.

## The checks

| Check                 | Level          | What it flags                                                                                     |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `no-recent-backup`    | Fix this first | The newest backup, or the newest dated export, is older than `maxAgeDays` (7 by default), or none |
| `backups-not-enabled` | Fix this first | The platform reports no backups: daily backups and point-in-time recovery off, or nothing listed  |
| `export-too-small`    | Fix soon       | The latest export is under 50% (or `shrinkPercent`) of the size of the one before it              |

Each has its what, why, fix and technical line in the [checks reference](../checks.md).

An export's date is the date in its file name (`2026-11-10`, `20261110`, `2026.11.10`). A file with no date
in its name is dated by when it was last changed, and the finding says so. When two files share a day, the
bigger one stands for the day, so a second run does not hide a good export.

## Keys, and the narrowest one

| Variable                | Asked                                                                         | What is read                                                                               |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN` | `GET https://api.supabase.com/v1/projects/<ref>/database/backups`             | Whether daily backups and point-in-time recovery are on, and each backup's status and time |
| `SANITY_TOKEN`          | `GET https://api.sanity.io/v2021-06-07/projects/<id>/datasets/<name>/backups` | Each backup's time. With `SANITY_PROJECT_ID`, and `SANITY_DATASET` (default `production`)  |

A token goes in a request header to that host only, and is never printed, logged or put in a result.

**Supabase has no read-only token type**: a personal access token acts as the account that made it. Make one
on an account that only needs this project, give it an expiry, and treat it as a key to that project.
Gaugeline names the project in `gaugeline.backups.json` because the project reference is not a secret and
is in no environment variable. If you would rather not hold a token, list an export folder instead: it needs
no key.

**Sanity** backups are a plan feature. A plan or token that cannot see them answers with an error status,
which is "could not be checked" with that status, never "no backups". An empty list is reported as "lists no
backups": Gaugeline cannot tell from it whether they are off or none has run yet, and says so.

Both endpoints and their field names (`walg_enabled`, `pitr_enabled`, `backups[].status`, `inserted_at`,
`physical_backup_data`, and Sanity's `createdAt`) were written from memory: the vendors' documentation could
not be reached when this page was written, and none of its text is quoted. If an answer differs, the
vendor's reference is right and this page is not; an answer in any other shape is "could not be checked".

## In the nightly run

`--backups` adds these checks to any page check, so they join the nightly run, and
`gaugeline run --all --backups` does it for every site in `gaugeline.sites.json`. The tokens come from
secrets, by site prefix like the other keys ([Many sites](many-sites.md)). A site with nothing set up adds
one "could not be checked" line, not a failure.

## Settings

`gaugeline.backups.json`, read from the folder you run from. Every field is optional.

| Field                 | What it does                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `maxAgeDays`          | The oldest the newest backup may be, 1 to 365. Default 7                                                                                |
| `supabase.projectRef` | The Supabase project whose backups are read: 20 lower-case letters                                                                      |
| `sanity.projectId`    | The Sanity project, when `SANITY_PROJECT_ID` is not set. Naming `sanity` at all makes a missing key worth a note                        |
| `sanity.dataset`      | The dataset, when `SANITY_DATASET` is not set. Default `production`                                                                     |
| `exports`             | Up to five folders of dated exports: `folder` (relative to where you run), `name` for the report, `shrinkPercent` (1 to 99, default 50) |

## Options

| Flag                            | What it does                                           |
| ------------------------------- | ------------------------------------------------------ |
| `--ci`                          | Exit 1 when a fix-first finding is found               |
| `--json`                        | Print the schema 2 result and nothing else             |
| `--allow-private`               | Check a site on this computer or a private network     |
| `--backups` (on the page check) | Add these checks to the page check and the nightly run |

## What it does not do

- It does not start a backup or an export, restore anything, or log in. It does not open an export file, so
  it cannot tell whether one is valid: a restore test is still yours to do once.
- It does not read a bucket over the network. Sync it to a folder (for example with `rclone`) and name the
  folder; reading a bucket needs signed requests and a key of its own.
- It does not read a platform's dashboard page. A platform with no documented read API is a line to check
  by hand.

What is requested, and from where, is on [Privacy and safety](../privacy.md#backups-gaugeline-backups).
