# Product presence cassettes

These three files were written by hand (by a script in the branch that added them), not recorded: no
Sanity, Stripe or Printful account was asked. The business, products, prices and ids are invented, and
tests never contact any of the three services. Each interaction answers one request of the Sanity,
Stripe or Printful connector in the shape those connectors read (see `SANITY-PRODUCTS.md`,
`STRIPE-PRODUCTS.md` and `PRINTFUL-PRODUCTS.md`; those shapes are not confirmed against the vendors'
current references).

Lowtide Surf Club, a small club with a merch shop, has five products on its website. Together the
cassettes plant one case for each of the six presence checks:

- `sanity-presence-surf` (project `lowtide1`): a logo tee, a hoodie, a tote, a swell poster and a
  digital wallpaper pack. All but the poster and the wallpaper pack carry the Stripe id and the
  Printful id.
- `stripe-presence-surf`: the hoodie is archived (`stripe-archived`), the poster has no product
  (`stripe-missing`), a surf lesson voucher is active and nothing links it (`stripe-orphan`), and an
  archived 2024 tee print is linked by nothing (and so reports nothing).
- `printful-presence-surf`: the tote's black colour is not synced (`printful-unsynced`), the wallpaper
  pack has no product (`printful-missing`), and a sample sticker sheet is linked by nothing
  (`printful-orphan`).

Used by `packages/core/src/checks/__tests__/product-presence.test.ts` and
`packages/core/src/products/__tests__/presence-docs.test.ts` (through `presence-store.ts`). Edit the
JSON by hand, or rebuild it with a script.
