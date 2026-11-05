# Payment link cassette

`payment-links.json` was written by hand, not recorded. The links and the pages are invented, so no
real seller's checkout is in the repository, and tests never ask Square or Stripe.

- `https://square.link/u/Sol4Box9`: a live checkout page.
- `https://buy.stripe.com/solana-gift-28` and `https://square.link/u/OldBox01`: each provider's
  page for a payment link that has been turned off ("This link is no longer active").
- `https://buy.stripe.com/gone-404`: a link that answers 404.

The inactive-link wording is the list in `INACTIVE_PHRASES`
(packages/core/src/checks/payment-link-dead.ts). If a provider changes its wording, update both.
