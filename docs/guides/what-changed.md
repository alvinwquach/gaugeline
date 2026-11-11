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

At most the newest 500 run files of a host are read, and pruning looks at the same 500, so older files beyond that stay on disk until you remove them. Per finding it keeps the check, the path and the title, never the evidence text. When history was pruned,
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
