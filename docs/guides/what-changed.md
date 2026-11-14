# What changed, and who changed it

After handoff, every new finding raises the same question between you and the client: is this a bug in
what you built (warranty), or did an edit after launch cause it (new work)? Without evidence it turns
into an argument. `gaugeline changes` gives you the evidence, and it states it the same way whichever
side it points to.

```sh
npx gaugeline changes <site> [--since <date|run-id>]
```

<!-- fixture: init-bar-wordpress -->

```sh title=Terminal
$ npx gaugeline changes harbourbar.example
```

```text title=Output
No runs are stored for this site yet. Run it with --since last first.
```

## A pop-up bar owner edits the events page

Harbour Bar's owner edits her own events page in Sanity. A week after handoff you run your usual check
with `--since last` on the events page, twice: on 1 November, before her edit, and on 3 November, after it.
Each run keeps a small record of the page in `.gaugeline/runs/`, and the second run finds new problems.

```sh
npx gaugeline harbourbar.example/events --since last
```

Then ask what changed:

<!-- fixture: changes-bar-events -->

```sh title=Terminal
$ npx gaugeline changes harbourbar.example/events
```

```text title=Output
page-lost-content on /events: A page lost content since the last run
  What changed on the page (1 Nov 2026 to 3 Nov 2026):
    the main content's text changed
    link removed: /book
    structured data type removed: Event
  unknown: Gaugeline cannot tell what changed it: content edits were not checked (no document is named for this page in gaugeline.changes.json); deploys were not checked (no deploy host is set up in gaugeline.changes.json).

page-lost-structured-data on /events: A page lost its structured data since the last run
  What changed on the page (1 Nov 2026 to 3 Nov 2026):
    the main content's text changed
    link removed: /book
    structured data type removed: Event
  unknown: Gaugeline cannot tell what changed it: content edits were not checked (no document is named for this page in gaugeline.changes.json); deploys were not checked (no deploy host is set up in gaugeline.changes.json).
```

The first half is already useful: the booking link and the Event markup left the main content between
the two runs. To learn why, tell Gaugeline where the records are, in `gaugeline.changes.json`:

```json
{
  "documents": { "/events": "events-page" },
  "deploys": { "provider": "vercel", "projectId": "prj_harbourbar" },
  "warranty": { "ends": "2026-11-30", "covers": "bugs in what was built" }
}
```

Set `SANITY_PROJECT_ID` and `SANITY_TOKEN` (a token with the Viewer role) and `VERCEL_TOKEN` (a token that
can read deployments) in the environment. If Sanity shows an edit to `events-page` between the two runs, the
finding says:

```text
content-edit: Changed by a content edit on 3 Nov 2026 by Sam Ortiz (document events-page).
This appeared inside the warranty period (it ends 30 Nov 2026) (covers: bugs in what was built).
```

You can paste those two lines into the client note. The fix for the finding itself is on its page in the
[checks reference](/docs/checks): here, put the booking link and the Event markup back in the events block.

## A before-and-after report

When you fixed things on purpose, the client wants the other half of the story: what is gone, what is new and what
is still open. `--before-after` puts the findings of two saved runs side by side. It reads only the runs
`--since last` saved, makes no request and looks for no cause:

```sh
npx gaugeline changes harbourbar.example/events --before-after
```

The latest run is "after". "Before" is the run just before it, or the run or date `--since` names: a run id such as
`r-20261101T100000Z`, or a date, which means the latest run taken on or before it.

- **Fixed**: on a page both runs read, in the before run and not in the after run.
- **New**: on a page both runs read, in the after run and not in the before run.
- **Still there**: in both.
- A finding is a check on a page. A finding on a page only one of the two runs read is counted under "Not
  compared", never called fixed or new.
- "What changed on the pages" lists the fields that differ on each page both runs read (title, content, links,
  structured data, scripts), the same ones `gaugeline changes` shows.
- With `--json` the same report is printed as JSON. A question the stored runs cannot answer (one run, an unknown
  run id, a date before the first run) is a sentence that says so, never a guess.

Harbour Bar, between the runs of 1 and 3 November. The owner's edit to the events page took out the booking link and
the Event markup, and happened to fix the event details search engines need:

<!-- fixture: changes-bar-events -->

```sh title=Terminal
$ npx gaugeline changes harbourbar.example/events --before-after
```

```text title=Output
Before: r-20261101T100000Z (1 Nov 2026)   After: r-20261103T100000Z (3 Nov 2026)
1 page read by both runs. Findings there: 6 before, 7 after.

Fixed (1)
  event-missing-fields  /events  Some events are missing details search engines need

New (2)
  page-lost-content          /events  A page lost content since the last run
  page-lost-structured-data  /events  A page lost its structured data since the last run

Still there (5)
  thin-html          /events  Google sees an almost empty page
  sitemap-missing    /events  Search engines can't find a list of your pages
  viewport           /events  This page isn't set up for phone screens
  canonical-missing  /events  The page doesn't say which address is the real one
  og-image-missing   /events  Shared links have no picture

What changed on the pages:
  /events: the main content's text changed; link removed: /book; structured data type removed: Event
```

The output is asserted by `packages/cli/src/__tests__/changes-before-after.test.ts` and checked by
`pnpm docs:examples`.

### Renewals and certificates

A domain, a token, a hosting project or the certificate of `www` belongs to the site, not to a page, so it has no
page to compare and no edit or deploy to blame. A run that used `--renewals` keeps these findings by their own
address (`domain:marlowe-bar.example`, `token:github`, `vercel:<project>`, `https://www.marlowe-bar.example/`),
and the report lists them in their own block, "Renewals", as fixed, new or still there. This is Marlowe Bar's
October: the domain was flagged on 22 October and renewed before the run of 31 October:

<!-- fixture: receipt-bar-october -->

```sh title=Terminal
$ npx gaugeline changes marlowe-bar.example --before-after --since r-20261022T060000Z
```

```text title=Output
Before: r-20261022T060000Z (22 Oct 2026)   After: r-20261031T060000Z (31 Oct 2026)
2 pages read by both runs. Findings there: 0 before, 0 after.

Fixed (0)
  none

New (0)
  none

Still there (0)
  none

Renewals fixed (1)
  domain-expires-soon  domain:marlowe-bar.example  The domain's registration runs out soon

Renewals new (0)
  none

Renewals still there (0)
  none
```

- A renewal is compared only for a check both runs could read. A run without `--renewals`, a run saved by an
  earlier version, or a check that could not read what it needed (the registry did not answer) says nothing, so a
  renewal missing from it is never called fixed and one that shows up after it is never called new. The report
  says "Renewals are not compared" or counts what was left out.
- Plain `gaugeline changes <site>` adds the same block, "Renewals since the run before:", with `new` and `fixed`
  lines and no page diff and no cause: a lapsing domain is not a content edit and not a deploy. The first run that
  read a renewal check has no earlier run to compare with, so its renewals are counted, not called new.
- The care-plan receipt files these findings under Renewals (see
  [the care-plan receipt](care-plan-receipt.md)).

## What it keeps

Each run saved with `--since last` writes one small file per run to `.gaugeline/runs/<host>/`, and prunes
the files older than 90 days (`retentionDays` in `gaugeline.changes.json`, 7 to 3650). Per page it keeps:

| Field           | What is stored                                                             |
| --------------- | -------------------------------------------------------------------------- |
| Title and h1    | The text, cut at 120 characters (it is public)                             |
| Canonical       | The address                                                                |
| Main content    | A hash of its text, never the text (header, footer and menus are left out) |
| Links           | Paths and addresses of the links in the main content, at most 200          |
| Structured data | The `@type` names in the page's JSON-LD                                    |
| Scripts         | Script addresses served, without query strings                             |

At most the newest 500 run files of a host are read, and pruning looks at the same 500, so older files beyond that stay on disk until you remove them. Per finding it keeps the check, the path and the title, never the evidence text. A renewal or certificate finding that is not on the checked page is kept the same way, by the address its check gave it (`domain:marlowe-bar.example`) instead of a path, with the list of renewal checks the run could read. When history was pruned,
a finding says `Changed before <date>, history not kept.` A finding on a page that has no earlier run is
counted, not explained.

## Where the evidence comes from

Gaugeline reads only records the systems already keep, with GET requests. It never guesses an author.

- Content edits: the content system's own history, through the adapter's optional `revisions` read, for
  the document you name per page in `documents`. Sanity is supported; an adapter without it is "could not
  check" and the reason names the platform. WordPress revisions are not built yet.
- Deploys: the Vercel or Netlify production deployment list, with the git commit each one built. The
  commit range is the commit live at the earlier run to the last one before the finding appeared. Gaugeline
  does not clone your repository.

| Revisions in the window | Deploys in the window | Label          |
| ----------------------- | --------------------- | -------------- |
| Yes                     | No                    | `content-edit` |
| No                      | Yes                   | `code-deploy`  |
| Yes                     | Yes                   | `both`         |
| No                      | No                    | `unknown`      |

Only deployments that finished (Vercel `READY`, Netlify `ready`) on production count; failed, cancelled and building ones, and ones with no state, do not. If Sanity returns 100 transactions for a document, or a deployment list fills a page without reaching back to the earlier run, the answer may be cut off and is reported as could not check. A source that was never configured is said to be "not checked", not "nothing recorded". A source that could not be read never counts as "nothing happened": with Sanity unreadable, a deploy alone
is `unknown`, and the reason says a content edit is not ruled out. The window is the time between the run
before the finding appeared and the run where it first did. The label is evidence, not a verdict: the words
are "changed by a content edit on 3 Nov by Sam Ortiz", never who is at fault, and the sentence for `both`
says the records do not show which one changed it.

## Editors' names

The only personal data kept is an editor's name as the content system shows it, in the output of
`gaugeline changes` for the run you asked about, not in the runs store. A name the system does not give
is shown as "an editor". Email addresses are never read into the output. See [privacy](/docs/privacy).

## The warranty note

With `warranty` set, each finding gets one line: "inside the warranty period" if it first appeared on or
before the end date, "after the warranty period" if it appeared later. It says nothing about price.

## Options

| Option            | What it does                                                                          |
| ----------------- | ------------------------------------------------------------------------------------- |
| `--since <value>` | Findings that appeared after a date (`2026-11-01`) or a run id (`r-20261101T100000Z`) |
| `--json`          | The same report as JSON on stdout                                                     |

By default `gaugeline changes` lists the findings that are new in the latest run. A run id that is not stored is an error that says where history starts (exit 2); a date newer than the latest run says so. Findings on pages other than the one a run checked are counted, not compared: run Gaugeline on those pages with `--since last` too. See
[options](/docs/options) for every flag.
