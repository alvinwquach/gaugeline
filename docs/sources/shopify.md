# Shopify as a price source

Available from version 0.2.0.

Read what a Shopify store charges and what is still in stock, with a token that can only view products.

A small shop's website, its checkout and its stock live in different places, and nothing keeps them in agreement. When the shop runs on Shopify, Shopify holds the price a customer pays and the count that decides whether the button works. This connector lets Gaugeline read that, so a price on a page or an "in stock" badge can be compared with the shop itself. It reads. It never changes a product, an order or a customer.

::: info
Today the connector reads the shop and nothing reports from it yet. The checks that compare a page with the shop arrive with the price checks in a later release. This page says exactly what is read, and with which token, so you can set it up once and leave it.
:::

## What you need

| Variable               | Needed | What it does                                                                                                                                              |
| ---------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHOPIFY_ACCESS_TOKEN` | Yes    | The shop's Admin API access token, from an app that has the `read_products` scope and no other ([below](#create-the-narrowest-token))                     |
| `SHOPIFY_SHOP_DOMAIN`  | Yes    | The store's `myshopify.com` address, such as `ridgeline-coaching.myshopify.com`. The store name on its own works too                                      |
| `SHOPIFY_API_VERSION`  | No     | A quarterly Admin API release such as `2025-07`. Set it when Shopify retires the one Gaugeline asks for ([which](#a-note-on-the-api-and-why-it-is-a-get)) |

If a required variable is missing or empty, Shopify is left out with a notice that names it, and the other systems are still read. That is "could not check", never "all fine". Keys come from the environment and from nowhere else: there is no flag, config file entry or prompt that accepts one, and a key is never printed, saved or put in an address.

The store address must end in `myshopify.com`. Your public domain (`ridgelinecoaching.example`) is not accepted, because the token is sent to this address and to no other.

## Create the narrowest token

Shopify tokens come from an app installed on the store, and the app's **Admin API access scopes** decide what the token may do. Gaugeline needs one: to view products.

1. In the Shopify admin, open **Settings**, then **Apps and sales channels**, then **Develop apps**, and create an app. Name it something you will recognise, such as `Gaugeline (read only)`. Shopify has been moving new custom apps to its Dev Dashboard; if the admin does not offer **Develop apps**, create the app there and install it on the store. The idea is the same.
2. Under **Admin API integration**, tick **`read_products`** and nothing else. Leave every scope that starts with `write_`, and orders, customers, discounts and inventory, unticked. Save.
3. Install the app on the store and copy the **Admin API access token**. Shopify shows it once.
4. Put it in the environment, not in a file: `SHOPIFY_ACCESS_TOKEN=… SHOPIFY_SHOP_DOMAIN=ridgeline-coaching.myshopify.com npx gaugeline open yoursite.com`.

`read_products` is also all it takes to see whether a variant is in stock: Shopify sends each variant's stock count and selling policy with the product, so Gaugeline does not need `read_inventory`.

If the token can do more than that, the run says so, once, as advice: it names the extra scopes (never the token) and tells you to make one with `read_products` alone. It does that by asking Shopify which scopes the token holds, which is a read of the token's own settings.

The scope names, menu names and the token's format are from memory of Shopify's documentation, which was not reachable when this page was written, so they are uncited. Check them at [shopify.dev](https://shopify.dev/docs/api/admin-rest) before you rely on them.

## A note on the API, and why it is a GET

Shopify's current Admin API is GraphQL, and every GraphQL call is a `POST`. Gaugeline sends only `GET` and `HEAD` requests to anything it checks, and there is no way for a connector to send anything else. So Gaugeline reads Shopify through the REST Admin API, where listing products is a plain `GET`.

Shopify calls that API legacy and has been steering new work to GraphQL. It still answers today, but if Shopify removes the product list from a version, the connector will stop working until it is moved. The way to do that without giving up the read-only promise is a GraphQL query that is checked before it is sent (the way the [Postgres source](/docs/connectors/postgres) checks its SQL), which would need its own decision record. That is not built, and this page will change when it is.

## What is asked

Three `GET` requests, all to your store's own address, with the token in the `X-Shopify-Access-Token` header and never in an address:

1. **The token's scopes**, to give the advice above. If this one fails for any reason but a wrong token, there is simply no advice.
2. **The shop's currency.** Product prices come without one. If the currency cannot be read, prices are still returned, with an empty currency, and one notice says so.
3. **The product list**, 250 products a page, following Shopify's `Link` header until there is no next page. At most 40 pages (10,000 products) are read; past that, one notice says how many were read.

That is all. Orders, customers, collections, discounts and images are not asked for. The 40-page cap, the choice of API version and the single retry on a rate limit are proposed, not Shopify's rules.

### What is kept

Per product: `id`, `handle` (its address on the storefront), `name` and `active` (true only when its status is active; draft and archived products are kept, as not active). Per variant: `id`, `sku` (left out when there is none, never an empty string), `price`, `currency` and `available`. Descriptions, images, variant names, barcodes and weights are not kept.

- **Prices** are whole numbers of minor units. Shopify sends a decimal string: `"54.00"` and `"54"` are both 5400, `"58.5"` is 5850. The text is split at the point, never multiplied. `"0.00"` is **0**, a free item, which is a price. An empty or unusable price is `null`, which is not a free one. A currency with no minor unit (the yen) keeps its whole number.
- **`available`** is `true` when the variant can be bought now and `false` when it is sold out: not tracked is available; tracked with stock is available; tracked with none left follows the shop's policy, so "stop selling" is sold out and "continue selling" is available. If Shopify does not say, it is `null`: unknown, never a guess.

## What the errors mean

| Shopify answers                                | The run says                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 401                                            | The token is wrong, or the app that made it was uninstalled. Copy the Admin API access token again. Nothing else is asked.       |
| 403 on the products                            | The token cannot read products. Give the app the `read_products` scope and install it again so the new scope applies.            |
| 404 on the shop                                | There is no store at that address. Check `SHOPIFY_SHOP_DOMAIN`.                                                                  |
| 429 with a `Retry-After` of 60 seconds or less | Gaugeline waits that long and asks once more. A second 429 gives up with a notice that says when to try again, in whole seconds. |
| 429 with no `Retry-After`, or a longer one     | Gives up at once with the same notice. Gaugeline does not guess how long to wait.                                                |

## Example: a coach's shop, and a hoodie whose price changed

Ridgeline Strength Coaching (invented, like every business on this page) sells a training hoodie, a month pass and an intro session through a Shopify store. The freelancer who built the site on Next.js and Sanity keeps the prices on the shop page in Sanity. In October the coach raised the hoodie from $48 to $54 in Shopify and the large to $58.50 and sold out of large. Nobody touched the page.

The freelancer made a `read_products` app, set `SHOPIFY_ACCESS_TOKEN` and `SHOPIFY_SHOP_DOMAIN`, and ran Gaugeline. Against an invented recording of the store (`packages/testkit/cassettes/shopify-shop.json`), the connector returns the hoodie like this:

```json title=Shopify products
[
  {
    "source": "shopify",
    "id": "7001",
    "handle": "training-hoodie",
    "name": "Training hoodie",
    "active": true,
    "variants": [
      {
        "id": "80011",
        "sku": "RL-HOOD-S",
        "price": 5400,
        "currency": "USD",
        "available": true
      },
      {
        "id": "80012",
        "sku": "RL-HOOD-M",
        "price": 5400,
        "currency": "USD",
        "available": true
      },
      {
        "id": "80013",
        "sku": "RL-HOOD-L",
        "price": 5850,
        "currency": "USD",
        "available": false
      }
    ]
  }
]
```

The shop charges **$54.00** (5400) for small and medium and **$58.50** for large, and large is sold out. The page still says $48.00 and still offers every size. The rest of the recording shows the other cases: the month pass is not tracked, so it is always available; the intro session costs **0** and the shop keeps selling it with a stock count below zero; the winter challenge is archived, so it is returned as not active rather than left out. The recording also has two list pages, to show that the second one is followed. The same shop on Square comes back in the [same shape](/docs/sources/square).

If the freelancer had pasted the wrong token, Shopify would refuse it, the run would say so, and the other systems would still be read:

```json title=Shopify notices
[
  {
    "connector": "shopify",
    "kind": "refused",
    "message": "shopify refused the key (HTTP 401). Shopify did not accept SHOPIFY_ACCESS_TOKEN: it is wrong, or the app that made it was uninstalled. Copy the Admin API access token again."
  }
]
```

Both outputs are asserted by `packages/core/src/connectors/__tests__/sources-docs.test.ts`.

## See also

- [Products and prices](/docs/products-and-prices): the other systems Gaugeline reads, and how keys are handled.
- [Square as a price source](/docs/sources/square): the same read for a shop or a food business on Square.
