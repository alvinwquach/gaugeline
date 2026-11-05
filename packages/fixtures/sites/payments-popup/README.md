# payments-popup

An invented tamal pop-up in two languages, for the payment checks (N05). Nothing here is a real
business, handle or payment link; the phone number is in the 555-01xx range reserved for fiction.

- `/` shows the configured Venmo, Cash App and Zelle details in its footer, a Square link and a
  Stripe gift-card link. A Venmo handle is also in an image description and an aria-label.
- `/es/` has a stale Venmo handle, `@solana-tamale`: `payment-handle-mismatch`.
- `/order` shows a PayPal.Me name nobody configured: `payment-handle-unknown`. Its `$12` sits
  next to "Cash App" and must not be read as a cashtag.
- The Stripe link answers with Stripe's inactive-link page in the `payment-links` cassette
  (packages/testkit): `payment-link-dead`. Tests never ask Square or Stripe.
- `gaugeline.payments.json` is the configuration the guide shows.
