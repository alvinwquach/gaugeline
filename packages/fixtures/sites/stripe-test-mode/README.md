# stripe-test-mode

An invented pop-up kitchen (La Olla Pop-Up) whose freelancer shipped the site with Stripe's test
publishable key, for the `stripe-test-mode` check (G23b). Nothing here is a real business or key.

- `index.html` has a test publishable key in an inline script.
- `/checkout.js` (same site) has a second test key. Both are `{{planted:...}}` placeholders the
  fixture server fills in at serve time (`PLANTED` in packages/fixtures/src/server.ts), so no
  key-shaped string is in the repository.
- The third-party `https://js.stripe.com/v3/` script is not the site's own and is never fetched.
- The page shows the tamal box at $42.00. In the recorded Stripe catalogue
  (`packages/testkit/cassettes/stripe-products.json`) the box now costs $48.00 and $42.00 is its
  archived price: the page was never updated after the price rose.
