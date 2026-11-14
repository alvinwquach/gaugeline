# price-stores

An invented pottery shop, Kiln & Co, for the gaugeline-free price agreement check (G14b). Nothing
here is a real business, product or price. Pages with the Shopify theme script also have the
public product JSON next to them (`/products/<handle>.js`, prices in cents).

- `/products/mug`: the page and the product data say 48.00, the product JSON charges 52.00.
- `/products/tea`: 12.00 everywhere.
- `/products/bowl`: not on Shopify; $30 on the page and 30 in the product data. No extra request.
- `/products/sold`: the product data says InStock, but it is sold out.
- `/products/vase`: two variants (Small 20.00, Large 35.00); the page shows "From $20.00".
- `/products/closed`: answers 403.
- `stores.txt` (with `{{origin}}` filled in by the tests): mug, tea and bowl, with a blank line, a
  comment and tea twice.
