# freshness-bar

An invented bar for N12: "Juniper Tap House", with a weekly specials board that the owner is meant
to update every Monday and a "Coming up" list. The docs test
(`packages/cli/src/__tests__/freshness-docs.test.ts`) runs it at 12:00 UTC on 10 November 2026:

- `/specials` was posted on 26 October, so by 10 November it is two weeks old and the rule allows 8
  days (`data-stale`).
- `/whats-on` still lists the trivia night of 5 November as coming up (`forecast-for-past-event`);
  the nights of 12 and 14 November are in the future.

Pages are plain files with relative links; the canonical, sitemap and share-image addresses name
`juniper.example`, which tests map to the files with an in-memory site. There is no database: the
rules need only the pages.
