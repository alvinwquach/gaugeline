# Data freshness: are the numbers as recent as they should be?

Available from version 0.2.0.

Data-heavy sites fail quietly. The script that copies last night's box scores into the database stops
on a Tuesday, the page keeps showing last week's numbers, and nobody notices until a fan does. Or the
sync is fine and the page is stuck on a cached copy of it. Or the "Picks" page still lists a game that
was played on Saturday. None of these is an error: every page loads, every status is 200.

Gaugeline reads what the page says about its own age, and tells you which of four things is wrong. You
say once what "recent enough" means for each kind of page, because only you know that a standings page
may be a day old in November and that the same page may sit unchanged all summer:

| Check                     | Level          | It says so when                                                                         |
| ------------------------- | -------------- | --------------------------------------------------------------------------------------- |
| `data-stale`              | Fix this first | The page's update time is older than you allow, while the data is expected to move.     |
| `data-no-stamp`           | Worth knowing  | A page under a rule shows no update time at all.                                        |
| `data-behind-source`      | Fix soon       | The page is older than its source (or a figure on it differs from the source's figure). |
| `forecast-for-past-event` | Fix soon       | A prediction, pick or "coming up" item is dated before now and shows no result.         |

They read and never write: the pages are fetched with `GET`, and the sources are read with a
published-only Sanity query or a read-only database transaction. Run them only against sites and
databases you own or have permission to read.

## Why "stale" and "behind the source" are different findings

They have different fixes, so each gets its own finding:

- **Stale, and the source is just as old:** the sync stopped. Look at the job, its schedule and its
  logs. The finding says so ("the sync looks stopped, not the site").
- **Stale or older than the source, and the source is fresh:** the sync works and the site is not
  picking it up. That is a cache or a revalidation setting, and fixing the sync would change nothing.
  This is `data-behind-source`, and `data-stale` stays quiet about the same page so you get one finding
  for one cause.

In a Next.js app on Vercel the second case is usually the page's revalidation time or a missing
on-demand revalidation: after the `revalidate` time has passed the next request still gets the old
copy while a new one is built in the background, and `revalidatePath` or `revalidateTag` only mark
the entry stale until the next request ([Next.js: Incremental Static Regeneration](https://nextjs.org/docs/app/guides/incremental-static-regeneration)).
When the stale copy came from a cache, the finding shows the `Age` header (see "When the page is
cached" below).

## Example: a basketball stats site that must update nightly during the season

Harbor City Hoops (invented, like every business on this page) is a stats site for a made-up league.
The freelancer who built it on Next.js and Vercel runs a nightly job that copies the box scores into a
Postgres database, and the pages are rebuilt from it. The league plays October to June, so the numbers
are expected to move in those months and are allowed to sit still the rest of the year. The owner
found out the last time from a fan's email, so the freelancer wrote down what "recent" means.

**1. Say what each kind of page must show.** `gaugeline.freshness.json` sits next to your other
Gaugeline files. It holds paths, selectors, durations and the names of sources, never a key:

```json title="gaugeline.freshness.json"
{
  "timeZone": "America/New_York",
  "freshness": [
    {
      "id": "player-pages",
      "page": "/players/*",
      "stamp": { "selector": "time.updated" },
      "maxAge": "6h",
      "activeWhen": { "months": [10, 11, 12, 1, 2, 3, 4, 5, 6] },
      "source": "db:latestPlayerSync",
      "maxLag": "1h",
      "spot": [
        {
          "name": "points per game",
          "selector": ".ppg",
          "source": "db:playerPpg",
          "tolerance": 0.1
        }
      ]
    },
    {
      "id": "standings",
      "page": "/standings",
      "stamp": { "selector": "time.updated" },
      "maxAge": "1d",
      "activeWhen": { "months": [10, 11, 12, 1, 2, 3, 4, 5, 6] },
      "source": "db:latestStandingsSync",
      "maxLag": "1h"
    },
    {
      "id": "team-pages",
      "page": "/teams/*",
      "stamp": { "selector": "time.updated", "jsonld": "dateModified" },
      "maxAge": "1d"
    },
    {
      "id": "picks",
      "page": "/predictions",
      "forecast": { "item": ".pick", "date": "time", "settled": ".final" }
    }
  ]
}
```

Read it aloud. A player page must show an update time in a `time.updated` element, no more than six
hours old in the months October to June, and no more than an hour older than the newest player sync.
Its points per game must match the database to a tenth. The standings page may be a day old. A team page
may be a day old, and its stamp may also be the `dateModified` of its structured data. On the Picks
page, any `.pick` whose date has passed and that has no `.final` score in it is a forecast for an event
that already happened.

**2. Say where the truth lives.** `db:` sources are named queries in
[`gaugeline.sources.json`](/docs/connectors/postgres), which holds the SQL and the name of the variable
with the connection string, never the string:

```json title="gaugeline.sources.json"
{
  "sources": {
    "db": {
      "type": "postgres",
      "env": "HARBOR_DB_URL",
      "queries": {
        "latestPlayerSync": "select max(finished_at) as value from sync_runs where job = 'players'",
        "latestStandingsSync": "select max(finished_at) as value from sync_runs where job = 'standings'",
        "playerPpg": "select slug as key, round(points::numeric / games, 1) as value from player_totals"
      }
    }
  }
}
```

A query that gives a time returns **one row**, and its column is called `value` (or it is the only
column). A query that gives a figure for many pages returns one row per page with two columns,
`key` and `value`; the `key` is the last part of the page's address (`sam-sample` for
`/players/sam-sample`). Make the role that runs them able to `select` only those tables, as the
[database page](/docs/connectors/postgres) shows; every statement is also checked before it is sent
and runs inside a read-only transaction.

**3. Run it** on the page where the pages you named are linked, with the variable set:

```sh title=Terminal untested="Needs a database. packages/cli/src/__tests__/freshness-docs.test.ts runs this page's commands against a stand-in Postgres and the invented harbor.example site at 12:00 UTC on 10 November 2026, and compares the output."
$ HARBOR_DB_URL=... npx gaugeline harbor.example
```

```text title="Output (the lines these checks add)"
✗ The numbers on this page are older than they should be
    /standings is stamped "2026-11-07T11:00:00Z" (3 days ago), and standings allows 24 hours. db:latestStandingsSync was last updated 3 days ago and the page is within 1 hour of it, so the sync looks stopped, not the site.
! The page is behind the data it is built from
    /players/jane-example is stamped "2026-11-10T07:00:00Z", 4 hours 50 minutes older than db:latestPlayerSync (updated 10 minutes ago); player-pages allows 1 hour. The data is in the source, so the site is not picking it up: look at caching and revalidation.
! The page is behind the data it is built from
    points per game on /players/sam-sample shows 19.1, and db:playerPpg has 19.8 (allowed difference 0.1; player-pages).
! The page still shows a prediction for something that already happened
    /predictions lists 1 prediction whose event is already over (picks): "Hawks at Harbor Sat Nov 7 Pick: Harbor by 4" (2026-11-07T19:00:00Z).
· A page of changing numbers does not say when they were updated
    /teams/hawks shows no stamp (team-pages): nothing matches time.updated, and the page has no dateModified in its structured data.
```

Each line names the rule, the page and the cause. The standings page and its source are both three
days old, so the nightly job is what stopped. Jane's page was built at 7:00 UTC and the player sync
finished at 11:50, so the data is in the database and the site has not picked it up: look at the
page's revalidation. Sam's page is fresh, but the figure on it is not the figure in the database,
which is the one fault a stamp cannot show (the page says "updated 11:30" and the number is last
week's). The Picks page keeps a pick for Saturday's game, while Sunday's pick is not reported because
it shows its final score. The team page has no update time at all, so nothing can be said about it.

The pages a rule names outright (`/standings`, `/predictions`) are read for you wherever the run
started. A pattern like `/players/*` is matched against the pages the run reads anyway: the page you
gave and a few it links to. To check a particular player, run Gaugeline on that player's page.

## The off-season

The same file, run at midday on 15 July, finds nothing wrong with the player pages and the standings,
because nobody expects them to move, and says so instead of passing them:

```text title="Output in July (the lines the windowed rules add)"
? data-behind-source could not be checked: The rule "player-pages" only applies in October to June (it is July in America/New_York), so whether the page is behind its source was not checked. (/)
? data-behind-source could not be checked: The rule "standings" only applies in October to June (it is July in America/New_York), so whether the page is behind its source was not checked. (/)
? data-no-stamp could not be checked: The rule "player-pages" only applies in October to June (it is July in America/New_York), so whether the page has a stamp was not checked. (/)
? data-no-stamp could not be checked: The rule "standings" only applies in October to June (it is July in America/New_York), so whether the page has a stamp was not checked. (/)
? data-stale could not be checked: The rule "player-pages" only applies in October to June (it is July in America/New_York), so how old the stamp is was not checked. (/)
? data-stale could not be checked: The rule "standings" only applies in October to June (it is July in America/New_York), so how old the stamp is was not checked. (/)
```

A "could not check" row never fails a run, and a check that looked at nothing is never shown as
passed. The rules without `activeWhen` (the team pages and the picks) are unaffected. The months are
months in the `timeZone` you set (or UTC without one), so a window that runs across New Year needs no
special case: it is a list of months, not a range.

## Example: a bar's weekly specials

The Juniper Tap House (invented) changes its specials board every Monday and lists the next few nights
on a "Coming up" page. There is no database: the owner edits both in Sanity and the freelancer wants
to know when they are not edited. The rules need only the pages:

```json title="gaugeline.freshness.json (the bar)"
{
  "timeZone": "America/Chicago",
  "freshness": [
    {
      "id": "weekly-specials",
      "page": "/specials",
      "stamp": { "selector": "time.posted" },
      "maxAge": "8d"
    },
    {
      "id": "coming-up",
      "page": "/whats-on",
      "forecast": { "item": ".night", "date": "time" }
    }
  ]
}
```

On 10 November the board still says "Posted Monday, October 26", and the trivia night of 5 November is
still listed as coming up:

```sh title=Terminal untested="Needs the clock fixed at 12:00 UTC on 10 November 2026. packages/cli/src/__tests__/freshness-docs.test.ts runs this page's commands against the invented juniper.example site with that clock and compares the output."
$ npx gaugeline juniper.example
```

```text title="Output (the lines these checks add)"
✗ The numbers on this page are older than they should be
    /specials is stamped "2026-10-26" (at least 14 days ago), and weekly-specials allows 8 days.
! The page still shows a prediction for something that already happened
    /whats-on lists 1 prediction whose event is already over (coming-up): "Thu Nov 5 Trivia night, 8pm" (2026-11-05).
```

"At least 14 days" is honest: the stamp is a date with no time, so Gaugeline only knows it is not more
recent than the end of that day in Chicago. A date alone is the whole day, and a finding is made only
when the page is out of date at every moment the stamp could mean.

## The file

`gaugeline.freshness.json` has a `timeZone` and a list of `freshness` rules (at most 20). A rule needs
at least one of `stamp`, `spot` or `forecast`.

| Field        | Meaning                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `timeZone`   | The site's own zone, like `America/New_York`. For stamps with no zone, for the months of `activeWhen` and for dates with no time.    |
| `id`         | Optional; lower-case words joined by hyphens. Unique in the file. Findings call the rule by it (else by its page).                   |
| `page`       | A path on the site, or a pattern: `*` is one part of the path (`/players/*`), `**` is any number of parts.                           |
| `stamp`      | Where the page shows when its data was updated: `selector`, `attr` (optional) and `jsonld` (a structured data property).             |
| `maxAge`     | How old the stamp may be: `"6h"`, `"2d"`, `"90m"`, `"1w"` (seconds, minutes, hours, days or weeks; at most 400 days). Needs `stamp`. |
| `activeWhen` | `{ "months": [10, 11, 12, 1, 2, 3, 4, 5, 6] }`: the months the rule applies in. Without it, always.                                  |
| `source`     | Where the newest sync time lives: `db:<query>` or `sanity:<type>.<field>`. Needs `maxLag`.                                           |
| `maxLag`     | How far behind the source the page's stamp may be. Needs `source`.                                                                   |
| `spot`       | Up to five figures on the page to compare with a source (below).                                                                     |
| `forecast`   | Predictions on the page whose event may be over (below).                                                                             |

### The stamp

`selector` names the element that shows the update time. Gaugeline reads, in this order, the attribute
you name in `attr`, else its `datetime`, `content`, the attribute the selector names (`[data-updated]`
reads `data-updated`) and `value`, and last the element's text. `jsonld` names a property of the page's
structured data (`dateModified` is the usual one, a [schema.org](https://schema.org/dateModified)
date); it is used when no element matches. Only what the page sends is read, without JavaScript, and
the first matching element is the one used.

A stamp is understood in these forms, and any other is **could not check**, never a guess:

| Form                                          | Examples                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| ISO 8601 and RFC 3339, with or without a zone | `2026-11-10T09:30:00Z`, `2026-11-10T04:30:00-05:00`, `2026-11-10 09:30`      |
| A date alone                                  | `2026-11-09` (the whole day)                                                 |
| HTTP dates and epoch times                    | `Tue, 10 Nov 2026 09:30:00 GMT`, `1794303000`, `1794303000000`               |
| English dates, with a clock and a zone        | `Nov 9, 2026 4:30 PM EST`, `9 November 2026, 16:30 -05:00`                   |
| Relative words                                | `just now`, `an hour ago`, `3 hours ago`, `2 days ago`, `yesterday`, `today` |

A label in front is ignored (`Updated:`, `Last updated`). Zone abbreviations are UTC, GMT and the US
ones (EST, EDT, CST, CDT, MST, MDT, PST, PDT); write anything else as an offset like `+05:30`.

**Time zones.** A stamp with a zone is one instant. A stamp without one is read in `timeZone` (and
follows daylight saving). With no `timeZone` it could be any zone from UTC-12 to UTC+14, so Gaugeline
reports `data-stale` only when the page is stale in every one of them, and otherwise says it could not
check and asks you to set `timeZone`.

**Relative words** are only as exact as they sound: "3 hours ago" is between three and four hours. A
relative stamp counts from when the page was made, so on a cached page the real age is longer; the
`Age` header (below) is the sign of it.

### `source` and `maxLag`

The source gives the time of the newest sync: a query returning one row with a timestamp (use
`timestamptz`, or an ISO 8601 string; a time with no zone is read as UTC), or a Sanity field such as
`sanity:siteSettings._updatedAt`. The page is **behind** when its stamp is older than that time by more
than `maxLag`. A page newer than its source is never behind it.

### `spot`: figures that must match

Up to five per rule. Each is `selector` (and optional `attr`), the `source` of the true figure, an
optional `name` for the finding, and a `tolerance`:

| `tolerance` | Meaning                                       |
| ----------- | --------------------------------------------- |
| omitted     | The two figures must be equal.                |
| `0.1`       | They may differ by 0.1.                       |
| `"2%"`      | They may differ by 2% of the source's figure. |

Figures are compared as exact decimals, not floats, so a tolerance of 0.2 accepts 28.1 against 27.9.
The page's text may carry a currency sign, thousands separators, a percent sign or a unit
(`1,234.5`, `$12.50`, `48.2%`, `27.3 PPG`); anything else, like a decimal comma (`27,3`), is could not
check rather than a guess. Put the figure in the same unit on both sides (a share as `48.2`, not
`0.482`). A spot check is reported by `data-behind-source`: a page that disagrees with its source has
not caught up with it.

### `forecast`: predictions for events that are over

| Field     | Meaning                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `item`    | A selector for each prediction on the page (up to 200 are read).                                      |
| `date`    | Inside each item, the element holding the event's date. Default: the item, or a `time` inside it.     |
| `jsonld`  | Instead of `item`: the date property (`startDate`) of the page's `Event` structured data.             |
| `settled` | An item that contains this already shows its result and is not a forecast any more.                   |
| `lasts`   | How long an event with a start time runs: `"3h"` by default. A date with no time lasts the whole day. |

An event is reported only when it is over at every moment its date could mean. The page being on
the 8th and the event being on the 9th is not a finding. A page with no predictions, an item with no
date and a date in a form that is not understood are listed as could not check.

## When the page is cached

"The sync ran and the page is still old" is, most of the time, a cached copy. When the page that
disagrees came back with an `Age` header (a CDN says it has held that copy for some time,
[RFC 9111](https://www.rfc-editor.org/rfc/rfc9111#name-age)), the finding says so:

```text
/players/jane-example is stamped "2026-11-10T07:00:00Z", 4 hours 50 minutes older than db:latestPlayerSync (updated 10 minutes ago); player-pages allows 1 hour. The data is in the source, so the site is not picking it up: look at caching and revalidation. The answer was served from a cache: Age 17400 (4 hours 50 minutes old), Cache-Control: public, s-maxage=3600. It may show the old state until it expires or is purged.
```

A page with no `Age` header gets no such line. It does not prove the page was not cached.

## When something cannot be read

A rule whose source, page or stamp cannot be read is listed under "could not check" with the reason.
It is never a pass and never a finding, because a number nobody could read is not a number:

| What happened                                                  | What you see                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SANITY_PROJECT_ID` or the connection variable is not set      | "could not check", naming the variable. Nothing is requested.                                        |
| Sanity or the database refuses, times out or is down           | "could not check", with what the source said (keys and passwords are replaced with `[redacted]`).    |
| The source's answer is not a time (or not a number)            | "could not check", showing the value (escaped) and what is accepted.                                 |
| The page has the stamp but in a form that is not understood    | "could not check", showing the text (escaped). `data-no-stamp` does not report it: there is a stamp. |
| No page this run read matches a pattern                        | "could not check", saying to run on a page under it or to name one page.                             |
| A page you named outright cannot be read (404, 403, no answer) | "could not check", with what the site answered.                                                      |

## Limits

The pages a rule names outright are read with `GET`, each once, from the same allowance of **16**
different pages as the [switches file](/docs/guides/switches-and-availability) (the checked page does
not count: it is already read). Patterns cost nothing: they match pages the run reads anyway. A rule
makes at most five spot checks, and a page is searched for at most 200 predictions. Each source is
read once per run, with one query or one Sanity `GET`, and the named queries share the one read-only
database connection the other checks use. There are no flags to raise the limits: they are a promise to
the site being checked. The four checks are not run at all unless `gaugeline.freshness.json` exists.

## Common questions

**Why a separate file from `gaugeline.switches.json`?** The two answer different questions (does the
site follow a state, and how old are its numbers), and a site often needs only one. They use the same
shapes for sources and paths, so they can be merged into one file later without changing a rule.

**Where do I put the secret?** You do not. Names and queries are in the files; the connection string
is in the variable the source names, and a Sanity token (only for a private dataset) is in
`SANITY_TOKEN`. Neither is ever printed.

**My stamp is generated in the browser.** Gaugeline reads the page as it is sent, as a crawler does.
A stamp that appears only after JavaScript runs is "no stamp" to it. Render it on the server from the
same record the numbers come from.
