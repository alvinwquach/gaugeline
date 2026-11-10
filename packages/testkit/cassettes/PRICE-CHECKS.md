# Price check cassettes

These three files were written by hand (by a script in the branch that added them), not recorded: no
Sanity, Stripe or Printful account was asked. The business, products, prices and ids are invented, and
tests never contact any of the three services. Each interaction answers one request of the Sanity,
Stripe or Printful connector in the shape those connectors read (see `SANITY-PRODUCTS.md`,
`STRIPE-PRODUCTS.md` and `PRINTFUL-PRODUCTS.md`; those shapes are not confirmed against the vendors'
current references).

Ember Supper Club, a pop-up kitchen, sells six things. Together the cassettes plant one case for each
of the four price checks, and one case each of the notices:

- `sanity-price-supper` (project `ember7sc`): a supper apron at 48, a hot sauce at 12, a tote bag at
  24.5, a sticker pack at 6, a tasting box at 45 and a gift card at 0.
- `stripe-price-supper`: the apron costs 5200 (so it disagrees with the website), the sauce, tote and
  stickers agree with it, the gift card is 0, and the tasting box has two prices (4500 and 5500) and no
  default price.
- `printful-price-supper`: the apron sells at 52.00 (it agrees with Stripe), the tote has a second
  colour at 29.00 against 24.50 (and no external id, so it is matched by name), and the sticker pack is
  priced in EUR against Stripe's USD.

Used by `packages/core/src/checks/__tests__/prices.test.ts` and
`packages/core/src/products/__tests__/price-docs.test.ts` (through `price-store.ts`). Regenerate nothing
by recording: edit the JSON by hand, or rebuild it with a script.
