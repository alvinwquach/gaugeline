# Product matcher cassettes

These two files were written by hand (by a script in the branch that added them), not recorded: no
Sanity or Stripe account was asked. The business, products, prices and ids are invented, and tests
never contact either service. Each interaction answers one request of the Sanity or Stripe connector in
the shape those connectors read (see `SANITY-PRODUCTS.md` and `STRIPE-PRODUCTS.md`). They go with the
existing `printful-merch` cassette, which holds the same invented coach's merch store.

- `sanity-match-merch`: Ridgeline Strength Coaching, project `ridge7st`, dataset `production`. Six
  products, written so that each of the four matching rules is needed once: a tee with both saved ids,
  a hoodie matched by `sanityId` and external id, a water bottle matched only by name, a tote matched
  only by a SKU that differs in case, a session pack that has no Printful product, and a poster that has
  no partner anywhere.
- `stripe-match-merch`: six products and six prices. A gift voucher exists only in Stripe.

Together with `printful-merch` (five products, one of them a draft poster whose name differs from
Sanity's) they give the fitness-store fixture of `packages/core/src/products/__tests__/match.test.ts`.
Regenerate nothing by recording: edit the JSON by hand, or rebuild it with a script.
