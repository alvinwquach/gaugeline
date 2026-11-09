# leaks-access

An invented wine bar for the app's Leaks & access view (G22c). Nothing here is a real business, key
or dataset.

- The page names Sanity project `mo7h1an7`, dataset `production` in its image address. The fixture
  never serves it: the end-to-end test answers that one host itself, so no request leaves the machine.
- `/assets/app.js` ships two secret keys (a Stripe secret key and a restricted key), filled in at
  serve time from `PLANTED` in packages/fixtures/src/server.ts, so no key-shaped string is in the
  repository. `/assets/vendor.js` is clean. `/assets/old-booking.js` does not exist (a 404).
- One link goes to a preview address (`moth-lantern-git-menu-studio.vercel.app`), which is never
  requested.
- `fixture.json` serves the same files for `staging.moth-lantern.test` too, with no noindex: the
  staging copy answers publicly (`staging-indexable`).
