# Hosted: schedules and history

The hosted version of Gaugeline (in progress, not released) checks every site you look after once a
night, at 03:00 in the site's own time zone, and keeps each night's run. It then compares the night with
the one before. A site where nothing opened or closed produces no message; a site that changed gets
one summary, which the morning email (in progress) sends.

The first night counts every finding as opened: there is no earlier night to compare with, so the
first summary lists everything the site has.

Only the public checks run on the hosted service. Checks that need your keys keep running in your own
CI and upload their results ([the runs API](./api.md)).

## An example: two agencies, three sites, one night

Northgate Studio looks after The Tidewater Bar and Juniper Pop-up Kitchen, both in London. Brightfield
Web looks after Maple Street Physio in Toronto. Each site's time zone is set on the site
(`sites.timezone`). The scheduler wakes every 15 minutes; this is what three of those wake-ups did on
12 November 2026 (times in UTC; output from the stand-in test database):

```sql title=psql untested="Needs a hosted database with pg_cron, which does not exist yet; the output below was captured from the test database."
select private.enqueue_nightly('2026-11-12T03:00:00Z');  -- 03:00 in London
select private.enqueue_nightly('2026-11-12T03:15:00Z');  -- the next wake-up
select private.enqueue_nightly('2026-11-12T08:00:00Z');  -- 03:00 in Toronto
```

```text title=Output
2
0
1
```

```text title=jobs
 name                   | night      | local time | status
------------------------+------------+------------+--------
 Juniper Pop-up Kitchen | 2026-11-12 | 03:00      | queued
 The Tidewater Bar      | 2026-11-12 | 03:00      | queued
 Maple Street Physio    | 2026-11-12 | 03:00      | queued
```

The two London sites got their job at 03:00 London time, the Toronto clinic at 03:00 Toronto time, and
the wake-up in between made nothing because tonight's jobs were already there.

## How a night works

1. **The schedule.** pg_cron calls `private.enqueue_nightly()` every 15 minutes. For each active site
   whose local time is between 03:00 and 07:00, it makes that night's job, once: a job is keyed by the
   site and its local date. A paused site (`sites.active = false`) gets none.
2. **The queue.** Jobs live in the `jobs` table: `queued`, `running`, `done` or `failed`. A worker claims
   a few at a time with `FOR UPDATE SKIP LOCKED`, so two workers never take the same job.
3. **The checks.** The worker runs Gaugeline's own public checks (the same code as the command line)
   against the address stored on the site, through the same fetcher: GET and HEAD only, private and
   cloud metadata addresses refused. A job has 10 minutes; see the table below for what happens at the
   deadline.
4. **The run.** The result is stored exactly as an upload from your CI is: one run, its findings and
   their fingerprints. Page text in a title, an evidence line, an address or a reason is cleaned before
   it is stored (see "Page text that would stop a night" below).
5. **The comparison.** The run's fingerprints are compared with the site's previous run _made by the
   worker_: an upload from your own CI in between is never "last night" (it ran other checks, on your
   clock). The comparison counts only checks that gave an answer in both runs: a check that crashed
   tonight does not "close" its findings, and one that could not check last night does not "open"
   them. The result is _opened_ (new tonight), _still open_ and _closed_ (fixed). If anything opened
   or closed, one row goes in `run_changes`; if not, nothing does, so nobody is messaged about a site
   that did not change.

## What happens when something goes wrong

| What happened                                   | What the queue does                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| The checks fail (a timeout, a crash)            | Tried again after a wait that doubles each time (about 1, then 2 minutes), with jitter  |
| They fail a third time                          | The job is `failed`; the other jobs carry on                                            |
| One site is slow and the checks pass 10 minutes | The job is stopped, recorded as `deadline` and retried like any failure; its slot frees |
| The site's address points at a private address  | `failed` at once with the reason; it is not retried and nothing is requested            |
| A worker dies or is redeployed mid-job          | After 15 minutes the job goes back to the queue and another worker runs it              |
| The site is paused after its job was queued     | The job ends as `done` with no run; the site is not requested                           |
| Consent is withdrawn while the checks run       | The probing findings are left out of the run and listed as not checked                  |
| Page text holds a key-shaped string or a NUL    | The string is cleaned and the run is stored; see below                                  |
| The site's time zone is not one Postgres knows  | The site gets no nightly job; the fan-out counts it (see "Time zones")                  |
| The clocks change                               | Nothing: a job is per local date, so no night runs twice and none is skipped            |
| A site is added at 02:59                        | It is checked that night, at the 03:00 wake-up                                          |
| The scheduler missed a wake-up                  | The next one before 07:00 makes the job                                                 |

A job row never holds a secret or a page's words: an error is stored as a short code
(`blocked-address`, `timeout`, `deadline`), never its message.

### Page text that would stop a night

A site chooses its own words, and a title, an evidence line, an address or a reason can quote them. The
runs API refuses an upload with a key-shaped string in it. The worker does not fail the night for that:
a stranger who can post a comment on the page could otherwise stop the site's monitoring every night.
Instead, before the run is stored, each of those fields is cleaned: control, direction and hidden
characters are removed or shown as `\u{1B}`, a NUL byte is dropped, the text is cut to a length, and
anything the secret scan matches (a Stripe key in a query string, a bearer token, a secret assigned to
a name that says so) is replaced by `[removed]`. The finding stays, with the same identity from night
to night. The run's summary says how many fields were touched (`redactedFields`, a count; the text
that was removed is never logged or stored). If a field still trips the scan after that, the finding
keeps its title and loses its evidence and address. An address over 2048 characters is cut, and a
title that is empty gets a fixed one, so neither can stop the night. A few leak shapes depend on words
elsewhere in the upload (a Contentful preview token counts only where the text names Contentful), so a
token in one finding and that word in another is invisible to the per-field scan. The last scan reads the
whole upload; if it still matches, the worker drops the evidence of every finding and every reason, then,
if needed, every title and address, and stores the run with the count in `redactedFields`. The scan
itself is the runs API's and is not loosened.

### Time zones

The 03:00 wake-up reads the zone on the site (`sites.timezone`). Write it as an IANA name exactly as
Postgres lists it in `pg_timezone_names` (`Europe/London`, `America/Toronto`); the match ignores case,
so `europe/london` works, but a name Postgres does not list (a typo, or an old alias this server's
timezone data does not have) gets no job. Each wake-up counts such sites: it raises a warning in the
database log (`enqueue_nightly: 1 active site(s) skipped: time zone not in pg_timezone_names`, with the
count and never the zone text), and the owner can ask at any time:

```sql title=psql untested="Needs a hosted database with pg_cron, which does not exist yet; the output below was captured from the test database."
-- Harbour Coffee Cart is set to 'europe/london' and Atlantis Spa to 'Atlantis/Lost_City'.
select private.enqueue_nightly('2026-11-12T03:00:00Z');
select private.skipped_nightly_sites();
```

```text title=Output
1
1
```

Harbour Coffee Cart got its job; Atlantis Spa did not and is the one skipped site.

## Probing checks

Probing checks (they ask a site for paths it does not publish) never run by default. A job runs them
only when it asks for them **and** the site's owner has consent on record for the current wording (see
[consent to probing checks](./data-model.md#consent-to-probing-checks)). Otherwise the run says the
probing checks could not be checked, and why, and the public checks run as usual.

## Running the worker

The worker is a long-running Node process (`apps/hosted/worker/worker.ts`). It needs one variable, the
app's database login (never the owner's):

| Variable                 | What it is                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `GAUGELINE_DATABASE_URL` | The app login: not the owner, not a superuser. The worker refuses to start otherwise |

The worker runs up to four jobs at once. It is a pool, not a batch: the moment a job finishes, its
slot takes the next job that is due, so one slow site does not hold the others back. On `SIGTERM` (a
deploy) it finishes the jobs it holds and claims no more.

### Known limit: many jobs on one host

Each job's fetcher sends at most 5 requests at a time. Nothing limits the requests to one host across
jobs, so two jobs for sites on the same host (or two workers) can together send more than 5 at once.
There is no cross-job limiter yet; keep the number of sites that share a host small, or run fewer
workers.

## Turning on the schedule

The migration (`0004_jobs.sql`) registers the schedule itself when the pg_cron extension is already
enabled. If you enable pg_cron later, register it once, as the database owner:

```sql title=psql untested="Needs pg_cron, which a plain Postgres does not have."
select private.schedule_nightly();
```

pg_cron keeps one time zone for the whole server (GMT unless `cron.timezone` is set), which is why it
wakes every 15 minutes and the database works out each site's local time, rather than one schedule per
site.
