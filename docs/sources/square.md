# Square as a price source

Available from version 0.2.0.

Read the items, variations and prices a Square account sells, with a token that can only view the catalogue.

A food business, a studio front desk or a market stall that takes cards through Square keeps its prices in Square's item library. The website often has its own copy. This connector lets Gaugeline read the library, so a price on a page can be compared with what the till charges. It reads. It never changes an item, takes a payment or touches an order.

::: info
Today the connector reads the catalogue and nothing reports from it yet. The checks that compare a page with it arrive with the price checks in a later release. This page says exactly what is read, and with which token, so you can set it up once and leave it.
:::

## What you need

| Variable              | Needed | What it does                                                                                    |
| --------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| `SQUARE_ACCESS_TOKEN` | Yes    | A production access token that can read the item library ([below](#create-the-narrowest-token)) |

If it is missing or empty, Square is left out with a notice that names it, and the other systems are still read. That is "could not check", never "all fine". The token comes from the environment and from nowhere else: no flag, config file entry or prompt accepts one, and it is never printed, saved or put in an address.

Gaugeline asks Square's production address only. A sandbox token is refused by it, so use a production token.

## Create the narrowest token

Square has no read-only key type you can pick from a menu, so start here: **a personal access token from the Developer Console can do everything the account can do, and it cannot be narrowed.** If you use one, Gaugeline still only sends `GET` requests, but the token itself could be used by anyone who holds it to change the account. Keep it for Gaugeline alone, so it can be revoked on its own, and prefer the option below.

The narrowest option is an OAuth access token that was granted one permission, **`ITEMS_READ`**, and nothing else:

1. In the Square Developer Console, create an application.
2. Send the account owner (your client) through Square's OAuth authorisation with the single permission `ITEMS_READ`. Square shows them what they are allowing, in plain words, and they can revoke it from their account.
3. Take the access token that comes back and put it in the environment, not in a file: `SQUARE_ACCESS_TOKEN=… npx gaugeline open yoursite.com`.

OAuth access tokens expire and are renewed with a refresh token, which Gaugeline does not do for you. When a run says Square did not accept the token, renew it.

The permission name, the menus and the token behaviour are from memory of Square's documentation, which was not reachable when this page was written, so they are uncited. Check them at [developer.squareup.com](https://developer.squareup.com/docs/catalog-api/what-it-does) before you rely on them.

## What is asked

One resource, by `GET`, with the token in an `Authorization: Bearer` header and never in an address:

- **The catalogue list, items only** (`/v2/catalog/list?types=ITEM`), following Square's cursor until there is none. At most 50 pages are read; past that, one notice says how many were read.

Orders, payments, customers and locations are not asked for. The 50-page cap and the single retry on a rate limit are proposed, not Square's rules.

### What is kept

Per item: `id`, `name` and `active` (false for a deleted or archived item, which is kept). Per variation, called a variant here: `id`, `sku` (left out when there is none), `price`, `currency` and `available`. Descriptions, images, categories and tax settings are not kept.

- **Prices** come from Square as whole minor units already (5400 is $54.00), so nothing is converted. A price of **0** is a free item, which is a price. A variation with **variable pricing** (the till asks for the amount) has no fixed price, and its price is `null`, which is not a free one.
- **`available` is always `null`.** Square keeps stock counts in a separate inventory service that needs a second permission. Gaugeline asks for the catalogue alone, so it cannot say whether an item is in stock, and says "unknown" rather than guess.

## What the errors mean

| Square answers                                 | The run says                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 401                                            | The token is wrong, expired or revoked. Create a new one.                                                      |
| 403                                            | The token cannot read the item catalogue. Give it the `ITEMS_READ` permission and nothing else.                |
| 429 with a `Retry-After` of 60 seconds or less | Gaugeline waits that long and asks once more. A second 429 gives up with a notice that says when to try again. |
| 429 with no `Retry-After`, or a longer one     | Gives up at once with the same notice. Gaugeline does not guess how long to wait.                              |

## Example: the same coach, at the studio front desk

Ridgeline Strength Coaching (invented) sells the same things at the front desk through Square that it sells online through [Shopify](/docs/sources/shopify): a training hoodie, a month pass and an intro session. The page still says the hoodie is $48.00. The till charges $54.00, and $58.50 for the large.

The freelancer set `SQUARE_ACCESS_TOKEN` to an `ITEMS_READ` token. Against an invented recording of the catalogue (`packages/testkit/cassettes/square-shop.json`), the connector returns the hoodie like this:

```json title=Square items
[
  {
    "source": "square",
    "id": "SQHOODIE0000000000000001",
    "name": "Training hoodie",
    "active": true,
    "variants": [
      {
        "id": "SQHOODIES000000000000001",
        "sku": "RL-HOOD-S",
        "price": 5400,
        "currency": "USD",
        "available": null
      },
      {
        "id": "SQHOODIEM000000000000001",
        "sku": "RL-HOOD-M",
        "price": 5400,
        "currency": "USD",
        "available": null
      },
      {
        "id": "SQHOODIEL000000000000001",
        "sku": "RL-HOOD-L",
        "price": 5850,
        "currency": "USD",
        "available": null
      }
    ]
  }
]
```

This is the same shape the Shopify connector returns, so whatever compares a page with a shop reads either one the same way: the prices, SKUs, currency and state here are identical to the Shopify recording of the same shop, and the page-against-shop comparison gives the same answer with both. The only difference is `available`: Shopify says whether the large is sold out, and Square says nothing. The recording has two catalogue pages, to show that the cursor is followed.

If the freelancer had created a token without the permission, Square would refuse it and the run would say what to change:

```json title=Square notices
[
  {
    "connector": "square",
    "kind": "refused",
    "message": "square refused the key (HTTP 403). SQUARE_ACCESS_TOKEN cannot read the item catalogue. Give the token the ITEMS_READ permission; nothing else is needed."
  }
]
```

Both outputs are asserted by `packages/core/src/connectors/__tests__/sources-docs.test.ts`.

## See also

- [Products and prices](/docs/products-and-prices): the other systems Gaugeline reads, and how keys are handled.
- [Shopify as a price source](/docs/sources/shopify): the same read for an online shop on Shopify.
