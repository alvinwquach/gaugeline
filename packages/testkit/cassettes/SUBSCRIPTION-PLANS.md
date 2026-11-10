# Subscription plan cassette

`stripe-plans-harbor.json` was written by hand (by a script in the branch that added it), not
recorded: no Stripe account was asked. The business, plans, prices and ids are invented, and tests
never contact Stripe. The shape is what the Stripe connector reads (see `STRIPE-PRODUCTS.md`),
with the `recurring` object a subscription price carries; that shape is not confirmed against
Stripe's current reference.

Harbor Street Yoga, a studio, sells three monthly plans and one more price:

- Foundation: 49.00 USD every month with a 7-day trial (`price_HarborFound4900`), and a yearly
  price of 490.00 USD (`price_HarborFound49000`) that no plan on the page stands for.
- Momentum: 129.00 USD, but billed every year. The page says per month.
- Elite: its first price, 249.00 USD, was archived; the current one is 299.00 USD.

Used by `packages/core/src/checks/__tests__/plans.test.ts` and
`packages/core/src/plans/__tests__/plans-docs.test.ts` (through `plan-store.ts`). Edit the JSON by
hand, or rebuild it with a script.
