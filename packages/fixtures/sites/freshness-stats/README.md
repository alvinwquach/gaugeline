# freshness-stats

An invented stats site for N12: "Harbor City Hoops", a made-up basketball league that plays October
to June with a nightly job copying box scores into the pages. Nothing here is a real team, player or
number. The docs test (`packages/cli/src/__tests__/freshness-docs.test.ts`) runs it at 12:00 UTC on
10 November 2026 with a stand-in Postgres:

- `/players/jane-example` is stamped 7:00 UTC, but the player sync finished at 11:50 UTC: the page is
  4 hours 50 minutes behind its source (a cache or revalidation problem), `data-behind-source`.
- `/players/sam-sample` is fresh, but shows 19.1 points per game where the database has 19.8
  (`data-behind-source`, a spot check).
- `/standings` is stamped 7 November and so is its source: the sync stopped (`data-stale`).
- `/teams/hawks` shows no stamp at all (`data-no-stamp`).
- `/predictions` still lists a pick for a game on 7 November that has no result beside it
  (`forecast-for-past-event`); the pick for 8 November shows its final score and is not reported.

Pages are plain files with relative links; the canonical, sitemap and share-image addresses name
`harbor.example`, which tests map to the files with an in-memory site.
