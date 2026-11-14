# ad-shop

An invented candle shop on a Shopify theme (Ember & Oak Candles), for the ad landing page checks
(`gaugeline ads`: the page that does not load, the product that is sold out, sample content). Nothing
in it is a real shop. The product endpoint answers at `/products/<handle>.js`, as Shopify's does.

- `/products/oat-candle`: every variant is sold out.
- `/products/linen-wick-set`: two of four variants are sold out.
- `/products/amber-tin`: in stock.
- `/products/empty-variants`: the endpoint answers with no variants (stock unknown).
- `/products/html-endpoint`: the endpoint answers with a web page, not JSON.
- `/products/no-endpoint`: the endpoint answers 404.
- `/products/sample-tin`: a product page still showing the theme's sample text.
- `/products/field-notes`: a page under `/products/` that is not on Shopify (no stock request is made).
- `/products/retired-mug`: answers 404.
- `/products/old-wick`: a 301 to the home page, which answers 200.
- `/products/preview-candle`: a 302 to `/password`, the storefront password page.
- `/collections/autumn`, `/`: Shopify pages that are not products.
