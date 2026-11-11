# Squarespace commerce: price and stock checks for stores built on Squarespace

Squarespace has no read API for pages or blog posts, but its Commerce APIs list a store's products, prices and stock. Gaugeline reads those two lists, with an API key that can only read, and compares them with what each product page on the live site shows. It only reads: every request is a `GET`.

## What this adapter reads, and the narrowest key

**The key first.** Squarespace makes API keys in the site's settings (Settings, Advanced, Developer API Keys), and the form lets you choose a permission for each API. Gaugeline needs two and nothing else: **Products** set to read, and **Inventory** set to read. Leave every other API, and every write permission, off. A key made this way can read the product and stock lists, and Gaugeline sends nothing but `GET` with it. Gaugeline's key kind for Squarespace commerce is `read-only`. Whether the Commerce APIs are offered at all depends on the site's plan: a site whose plan does not have them answers 403, and that is could-not-check, not a pass (plan names `uncited`).

**What it does not read.** Pages and blog posts have no read API in Squarespace. They stay with the live-site adapter (`builders`, see [Hosted builders](/docs/integrations/builders)), which reads only what a visitor can see. Orders, customers, profiles and the order-fulfilment endpoints are never asked: they hold private data, and some of them are writes.

This page lists what the adapter reads, a worked example for a freelancer's client, what it could not check and why, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Documentation checked on: 2026-11-11, by trying to read Squarespace's developer documentation at [developers.squarespace.com](https://developers.squarespace.com/) (the Commerce APIs overview, Products, Inventory, authentication and rate limits). The pages could not be reached from the build environment (the request was refused by its proxy), so the paths, the answer shapes, the permission names, the page size and the rate limit below are from memory and are `uncited`. Check this page against Squarespace's current documentation before relying on a detail. [docs]

## What it reads

Every request is a `GET` to `https://api.squarespace.com/1.0/commerce`, through the same fetcher as every other request. Nothing else is ever sent. The product pages on the live site are asked with a plain `GET` too, with no key.

| Endpoint                      | What for                                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /1.0/commerce/products`  | The store's products: id, type, slug, page path, visible or hidden, times and each variant's price (a decimal text and a currency). `uncited` |
| `GET /1.0/commerce/inventory` | Each variant's stock: a quantity, or unlimited. `uncited`                                                                                     |

Both lists come a page at a time. Gaugeline asks for the next page with the cursor the last answer gave and stops at the page that says it is the last. It never follows an address the answer names. It reads at most 400 pages and 10,000 items from one list, so a server that never says "last" ends the read as could-not-check. A cursor that is missing, repeated or made of unexpected characters ends it too. When Squarespace answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

## Make the key

In Squarespace, open Settings, Advanced, Developer API Keys, and generate a key. Name it for Gaugeline, set Products and Inventory to read and everything else to none, and copy it once: Squarespace shows it only when it is made. Put it in the environment where Gaugeline runs, never in a file you commit:

```text
SQUARESPACE_COMMERCE_TOKEN=<the key>
```

The key goes in an `Authorization` header and never in an address, it is sent only to `https://api.squarespace.com/1.0/commerce` (a redirect to another origin is followed without it, and the requests to your own site never carry it), and every message, finding and report has it blanked.

### What reaches your computer

Squarespace's product list sends each product's whole record with it, names, descriptions and image addresses included, and there is no parameter that leaves them out. Gaugeline reads those values for exactly two things: counting which products have a field, and hashing the fields the settings name. It keeps only the id, the page path, the kind, whether the product is visible, its times, and each variant's price and stock. Nothing but a short hash is printed, logged or put in a finding or report. With no `fingerprint` in the settings, nothing is hashed at all.

## Example: a pop-up print shop on Squarespace

Tideline Print Shop is an invented pop-up shop. A freelancer built its store on Squarespace: signed prints in two sizes, a canvas tote, a zine, and a card set that is hidden until the winter launch. The owner changes prices and stock from her phone, and a sale on the tote ended last week. The freelancer wants to know, before the weekend market, whether any product page still shows a price or a stock level the store no longer has.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "squarespace-commerce",
      "fingerprint": {
        "products": ["name", "description"]
      },
      "urls": {
        "products": "/shop/{slug}"
      }
    }
  ]
}
```

The `urls` pattern is used only for a product whose answer names no page path. This is what the adapter reads from the invented store, and what the two checks say when two product pages have drifted (the tote's page still shows the full price of the sale, and the zine's page says sold out):

```json title=Output
{
  "types": [
    {
      "name": "products",
      "count": 3
    }
  ],
  "product fields": {
    "name": 3,
    "description": 2,
    "tags": 0
  },
  "a type that does not exist": "Squarespace commerce has no type \"pages\". Its only type is \"products\" (the Commerce Products API). Pages and blog posts have no read API.",
  "drafts reachable": true,
  "published products": [
    {
      "id": "p-dawn",
      "type": "products",
      "url": "/shop/harbour-at-dawn",
      "slug": "harbour-at-dawn",
      "publishedAt": "2026-10-01T09:00:00.000Z",
      "updatedAt": "2026-10-20T08:30:00.000Z",
      "fieldHashes": {
        "name": "ea4fdb3c44458492",
        "description": "abd5fb6760b03b39"
      }
    },
    {
      "id": "p-tote",
      "type": "products",
      "url": "/shop/tide-chart-tote",
      "slug": "tide-chart-tote",
      "publishedAt": "2026-10-05T09:00:00.000Z",
      "updatedAt": "2026-11-02T17:00:00.000Z",
      "fieldHashes": {
        "name": "3196a2b20f49edc9",
        "description": "8a52c5d9b79e7b8f"
      }
    },
    {
      "id": "p-zine",
      "type": "products",
      "url": "/shop/sea-glass-zine",
      "slug": "sea-glass-zine",
      "publishedAt": "2026-10-12T09:00:00.000Z",
      "updatedAt": "2026-10-12T09:00:00.000Z",
      "fieldHashes": {
        "name": "18c47bf2120e4596"
      }
    }
  ],
  "findings": [
    "squarespace-price-differs: tide-chart-tote: the page shows 40.00 USD and the Commerce API has 32.00 USD",
    "squarespace-stock-differs: sea-glass-zine: the page offers it as out of stock and the Inventory API says a variant is in stock"
  ]
}
```

Three products are visible and a fourth, the card set, is hidden: `drafts reachable` is `true` because the key can see a product that visitors cannot, and its page is never asked. The hashes change when a product's name or description changes, and the report shows field names and numbers, never the shop's words. The two findings give both sides' numbers and say nothing about which is right: the tote's page shows 40.00 while the store has 32.00 (the sale price), and the zine's page says sold out while the store says it has unlimited stock. A zine with a hash for `name` only has no description, which is counted, not hashed as empty.

## The two checks

Both run on every visible product, one `GET` of its page each (at most 300 a run), and quote numbers, ids and slugs only. Prices are whole numbers in minor units (cents), parsed from Squarespace's decimal text without a float, and compared only in a currency with two decimal places when both sides name the same currency. There is no conversion.

| Check                       | It says                                                                                                                                                                        | It does not say                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `squarespace-price-differs` | A price in the page's product data (or the one price it shows) is none of the prices the store holds for that product's variants. A "From" price must be the lowest.           | Which side is right. A page may show one variant's price: that is not a mismatch. |
| `squarespace-stock-differs` | The page offers the product as in stock while the Inventory API says every variant is out, or the page says out of stock while the Inventory API says a variant can be bought. | A stock count. Only the two words, in stock and out of stock, are compared.       |

A product with several variants counts as in stock when any variant is. A variant with no inventory row is never read as out of stock. While a variant is on sale, its price is the sale price.

The page side is read for this product only. A page with several Product data blocks (a related product beside it) uses the block whose address or SKU is the product's, and none matching is could-not-check. Offers in more than one currency, a price element that holds two amounts with neither struck through, a variant the API listed with an unusable id, a variant on sale with no sale price, and a product whose address is on another site are all could-not-check, never a finding. A "sold out" button counts only when it is the page's one add-to-cart button, and a product the API lists twice is read once.

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from the platform's admin screens:

| Question                                    | Answer here  | Why                                                                                                              |
| ------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| Pages and blog posts (their text, drafts)   | not read     | Squarespace has no read API for them. The `builders` adapter reads what a visitor can see.                       |
| Orders, customers, profiles, transactions   | never asked  | Private data, and the key would need more permissions than Gaugeline asks for.                                   |
| Who has access to the site (`members`)      | not offered  | The Commerce APIs do not list the site's contributors.                                                           |
| Stock changes (adjusting inventory)         | never sent   | Those endpoints write (they use `POST`), and Gaugeline is read-only. No part of a check needs one.               |
| A product page in another currency          | not compared | Prices are never converted. Both currencies are named in the could-not-check line.                               |
| A currency without two decimal places       | not compared | The page readers read two places; a yen or dinar price is left to a later branch.                                |
| A product page that shows no price or stock | not compared | A theme that prints neither in its product data or visible text cannot be compared, and absence is never a pass. |
| A hidden product's page                     | not asked    | A product that is not visible has no live page. The key can see it, which is what `drafts reachable` reports.    |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `SQUARESPACE_COMMERCE_TOKEN` is not set (nothing is asked), or Squarespace does not accept it (HTTP 401);
- the key lacks a permission (HTTP 403): the Products permission stops everything, and the Inventory permission stops only the stock check, so the price check still runs. A site whose plan does not offer the Commerce APIs answers the same way;
- an answer is not the shape Squarespace sends, or a product has no usable id or update time;
- a list is bigger than the bound, or its cursor is missing, repeated or unusable.

A store that lists no visible product is could-not-check too, never a clean pass: a key that cannot see the store looks the same as an empty one. A platform that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

## What is bounded

| Limit                          | Value  |
| ------------------------------ | ------ |
| Pages read from one list       | 400    |
| Items read from one list       | 10,000 |
| Product pages asked in one run | 300    |

There are no flags to raise them.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `squarespace-commerce`.                                                                                                         |
| `adapters[].fingerprint`        | Fields of a product to hash, by type (the only type is `products`). Up to 20 per type.                                          |
| `adapters[].urls`               | Where a product's page lives when the answer gives no path: a path or an https address. Only `{slug}` and `{id}` are filled in. |

| Environment variable         | What it is                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `SQUARESPACE_COMMERCE_TOKEN` | The key: a Squarespace API key with Products and Inventory set to read, nothing else. |
