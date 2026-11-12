# Hosted: schedules and history

The hosted version of Gaugeline (in progress, not released) checks every site you look after once a
night, at 03:00 in the site's own time zone, and keeps each night's run. It then compares the night with
the one before. A site where nothing opened or closed produces no message; a site that changed gets
one summary, which the morning email (in progress) sends.

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
   cloud metadata addresses refused.
4. **The run.** The result is stored exactly as an upload from your CI is: one run, its findings and
   their fingerprints. Page text in a title or an evidence line is cleaned before it is stored.
5. **The comparison.** The run's fingerprints are compared with the site's previous run: _opened_
   (new tonight), _still open_ and _closed_ (fixed). If anything opened or closed, one row goes in
   `run_changes`; if not, nothing does, so nobody is messaged about a site that did not change.

## What happens when something goes wrong

| What happened                                  | What the queue does                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| The checks fail (a timeout, a crash)           | Tried again after a wait that doubles each time (about 1, then 2 minutes), with jitter |
| They fail a third time                         | The job is `failed`; the other jobs carry on                                           |
| The site's address points at a private address | `failed` at once with the reason; it is not retried and nothing is requested           |
| A worker dies or is redeployed mid-job         | After 15 minutes the job goes back to the queue and another worker runs it             |
| The clocks change                              | Nothing: a job is per local date, so no night runs twice and none is skipped           |
| A site is added at 02:59                       | It is checked that night, at the 03:00 wake-up                                         |
| The scheduler missed a wake-up                 | The next one before 07:00 makes the job                                                |

A job row never holds a secret or a page's words: an error is stored as a short code
(`blocked-address`, `timeout`), never its message.

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

On `SIGTERM` (a deploy) it finishes the jobs it holds and claims no more.

## Turning on the schedule

The migration (`0004_jobs.sql`) registers the schedule itself when the pg_cron extension is already
enabled. If you enable pg_cron later, register it once, as the database owner:

```sql title=psql untested="Needs pg_cron, which a plain Postgres does not have."
select private.schedule_nightly();
```

pg_cron keeps one time zone for the whole server (GMT unless `cron.timezone` is set), which is why it
wakes every 15 minutes and the database works out each site's local time, rather than one schedule per
site.
