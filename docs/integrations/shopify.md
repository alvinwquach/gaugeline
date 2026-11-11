# Shopify: content checks for sites built on Shopify

What a Shopify store says is published to its Online Store, against what the live site shows. Gaugeline reads the Storefront API with its public, read-only access token, and nothing is ever written.

## What this adapter reads, and the narrowest key

**The key first.** Shopify's Storefront API access token is public and read-only by design: it is the token a store's own theme or headless storefront puts in the page, and with it a program can read what the Online Store shows every visitor, and cannot change, create or delete anything. You make it in the Shopify admin by creating an app (or a custom storefront) and choosing which Storefront API scopes it has. Gaugeline needs two: `unauthenticated_read_product_listings` (products and collections) and `unauthenticated_read_content` (pages, blogs and articles). Gaugeline's key kind for Shopify is `read-only`. The Admin API is not used: its tokens carry scopes that can write, and Gaugeline would have no way to make one that cannot.

This page lists the endpoint the adapter uses, how to make the token, a worked example for a freelancer's client, what the three Shopify checks find, what could not be checked, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Documentation checked on: 2026-11-11, and it could not be read: the build session's network policy refused `shopify.dev`. The endpoint path, the GraphQL field names (`onlineStoreUrl`, `priceRange`, `availableForSale`, the `nodes` and `pageInfo` connections), the scope names and the rate-limit behaviour below are from the build's knowledge of the Storefront API and are marked `uncited`: each is pinned by Gaugeline's tests over invented answers, not confirmed against the live pages. Check them against the current [Storefront API reference](https://shopify.dev/docs/api/storefront) before relying on a detail. The allowlist entry that lets Gaugeline send this one query carries `checked: null` for the same reason. [docs]

## What it reads

The Storefront API answers a read only to a `POST` (it has no `GET`). Gaugeline sends it only through the read-only query rule in [ADR-0006](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0006-read-only-post-queries.md): an allowlist entry that names the one endpoint, and a body that must be a single GraphQL `query` (a `mutation` or a `subscription` is refused before anything is sent, and a redirect is never followed).

| Endpoint                                                       | What for                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST https://<shop>.myshopify.com/api/<version>/graphql.json` | A `query` for `products`, `collections`, `pages`, `blogs` or `articles`: id, handle, `onlineStoreUrl`, the time fields the type has, and only the fields your settings name. For products, also `priceRange` and `availableForSale` for the drift check. Header: `X-Shopify-Storefront-Access-Token`. |

`<shop>` is `SHOPIFY_SHOP_DOMAIN`, which must be the store's `myshopify.com` address (a custom domain is not accepted, because the token is sent to this host and no other). `<version>` is `SHOPIFY_API_VERSION`, a quarterly release such as `2026-10`, which is the default (uncited: shopify.dev could not be reached to confirm which releases are current).

Lists are read by cursor: the next page is asked for with the `endCursor` the API returned, as long as `hasNextPage` is true. The adapter counts what was returned, never what it asked for. It stops with could-not-check, never with a partial list passed off as complete, when the API sends more nodes than were asked for, says there is more but gives no cursor (or one longer than 512 characters), repeats a cursor, sends an empty page that says there is more, or has more than 10,000 items of one type. A page that is too big is asked again with half as many items, down to 10. A list is also stopped after twice the pages the 10,000-item bound needs at the normal page size. A `THROTTLED` error or a 429 with a short `Retry-After` is waited out once; after that the run keeps what it read and says it is partial.

An item is **published** when Shopify gives it an `onlineStoreUrl`: that is the Storefront API's way of saying it is published to the Online Store. An item hidden from the Online Store channel has none, so it is not counted, not listed and never reported as missing. Its address is read as a path only (one leading `/`, plain segments, no `//`, no `..`), never as a host.

## Make the token

In the Shopify admin, create an app (Settings, Apps and sales channels, Develop apps) or use the Headless sales channel, and give its Storefront API access the two read scopes above and nothing else. Put the token in the environment where Gaugeline runs, never in a file you commit:

```text
SHOPIFY_STOREFRONT_TOKEN=<the Storefront API access token>
SHOPIFY_SHOP_DOMAIN=larkspur-ceramics.myshopify.com
SHOPIFY_API_VERSION=2026-10
```

`SHOPIFY_API_VERSION` is optional. `SHOPIFY_SHOP_DOMAIN` is the same variable the Shopify product connector reads. The token goes in a header and never in an address, it is sent only to the shop's own host, and every message, finding and report has it blanked.

### What reaches your computer

The Storefront API returns the fields a query names. The adapter names a field only when your settings ask for it, from a fixed list per type, so nothing else is asked for. Field values are used for exactly two things: counting which items have a field and hashing the fields the settings name. The adapter keeps no value, and nothing but the short hash is printed, logged or put in a finding or report. With no `fingerprint` in the settings, no field is asked for at all. For the drift check only, the product's price range and availability are read as numbers and a flag.

## Example: a ceramics studio on Shopify

Larkspur Ceramics is an invented two-person studio. A freelancer built its store on Shopify: speckled mugs and ash-glaze bowls, a few pages, and a journal. The owners hide "kiln seconds" boxes from the Online Store until they are photographed, and change prices between firings. The freelancer wants to know that every published product still has a live page, and that a price edited in Shopify is the price the page shows.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "shopify",
      "fingerprint": {
        "products": ["title", "description"]
      }
    }
  ]
}
```

What the adapter reads over the invented store (a test compares this with the tool):

```json title=Output
{
  "types": [
    {
      "name": "articles",
      "count": 1
    },
    {
      "name": "blogs",
      "count": 1
    },
    {
      "name": "collections",
      "count": 2
    },
    {
      "name": "pages",
      "count": 2
    },
    {
      "name": "products",
      "count": 2
    }
  ],
  "product fields": {
    "title": 2,
    "description": 1,
    "vendor": 0
  },
  "drafts reachable": false,
  "published products": [
    {
      "id": "1001",
      "type": "products",
      "url": "/products/mug-speckled",
      "slug": "mug-speckled",
      "publishedAt": "2026-10-01T09:00:00.000Z",
      "updatedAt": "2026-10-20T08:30:00.000Z",
      "fieldHashes": {
        "title": "069b8c88fd61795d",
        "description": "68a9c0f526fbd750"
      }
    },
    {
      "id": "1002",
      "type": "products",
      "url": "/products/bowl-ash-glaze",
      "slug": "bowl-ash-glaze",
      "publishedAt": "2026-10-05T09:00:00.000Z",
      "updatedAt": "2026-11-02T17:00:00.000Z",
      "fieldHashes": {
        "title": "bae0fa5aa73a9def"
      }
    }
  ]
}
```

Read it the way the freelancer does. Of three products, two are published to the Online Store; the third (the kiln seconds box) is hidden, so it is neither counted nor reported. Both published products have a `title`, only one has a `description`, and nothing has a `vendor`. The API token cannot see drafts, so `drafts reachable` is `false`. The hashes change when a title or description changes, and the words themselves never leave Shopify's answer.

## The three checks

These read the store and the live site together (`readShopify`, then `createShopifyRegistry` from `@gaugeline/core`), the way the Webflow checks do. Each finding names an item by handle and path, never by its words.

| Check                             | What it finds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shopify-item-no-page`            | A product, collection, page, blog or article published to the Online Store whose address answers 404 or 410 on the live site. A hidden item is never asked for. A page that redirects to the home page is a finding; one that ends on the store's password page is could-not-check. Products are read first, so a page budget cuts the least valuable pages first.                                                                                                                                                                                                             |
| `shopify-product-drift`           | A product page whose price (or product data price) is outside the Storefront API's range for it, or whose availability contradicts `availableForSale`. Reuses the price and availability reading of `prices-disagree`. A currency whose minor unit is not hundredths (yen, won, dinar) and a page in another currency are could-not-check, never converted. Availability is judged on every offer the page lists, never a sold-out button.                                                                                                                                     |
| `shopify-theme-preview-indexable` | A link on the live site to a theme preview (`preview_theme_id` or a `shopifypreview.com` host) that has no noindex and no canonical to the public page. Only addresses the site itself links to are asked for, and only on the site's own host, the store's own `myshopify.com` host (`SHOPIFY_SHOP_DOMAIN`) or the store's own `shopifypreview.com` host; a link to another store's Shopify host is not asked for and is could-not-check; none is guessed. The address in a finding keeps only `preview_theme_id`. A canonical to a different address makes it not indexable. |

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from the platform's admin screens:

| Question                                         | Answer here    | Why                                                                                                          |
| ------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------ |
| Drafts and unpublished products                  | not reachable  | A Storefront API token sees only what is published, by design. `drafts reachable` is `false`.                |
| Products sold only through a headless storefront | not counted    | With no Online Store address they look hidden. The adapter is for the Online Store.                          |
| Who has access to the store (`members`)          | not offered    | The Storefront API has no staff list.                                                                        |
| Item counts without reading the items            | read in full   | The Storefront API has no total, so counts come from reading every page, up to 10,000 items per type.        |
| Blog and article update times                    | not given      | Shopify gives a blog no times and an article only its publish time; `updatedAt` is left out, never invented. |
| Items in other languages and markets             | default only   | The adapter reads the store's default market.                                                                |
| Theme previews nobody links to                   | not looked for | The adapter never guesses a preview address (that would be probing).                                         |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `SHOPIFY_STOREFRONT_TOKEN` or `SHOPIFY_SHOP_DOMAIN` is not set (nothing is asked), the token starts with an Admin API prefix (`shpat_`, `shpss_`, `shpca_`, `shppa_`: refused before anything is sent), `SHOPIFY_SHOP_DOMAIN` is not a `myshopify.com` address (the token is not sent), or `SHOPIFY_API_VERSION` is not a quarterly release;
- Shopify does not accept the token (HTTP 401) or says it may not read a part (403, or an `ACCESS_DENIED` error): a type the token may not read (for example articles, without `unauthenticated_read_content`) is could-not-check by itself, and the checks still run on the other types;
- the answer holds GraphQL `errors` (their messages, which can quote content, are never repeated), is not JSON, or is not the shape Shopify sends;
- an item has an id of the wrong kind or no update time where its type has one (that type is could-not-check); an item whose handle is not a plain ASCII handle (so `über-uns` is flagged) or whose address is not a plain page path is skipped and listed by id as could-not-check, and the rest of its type is still read;
- a list stops moving, over-fills a page, loses its cursor or is bigger than the bound.

## What is bounded

| Limit                       | Value  |
| --------------------------- | ------ |
| Items in one page of a list | 50     |
| Items read from one type    | 10,000 |
| Live pages asked in one run | 300    |
| Theme previews followed     | 5      |

There are no flags to raise them.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `shopify`.                                                                                                                               |
| `adapters[].fingerprint`        | Fields to hash, by type (`products`, `collections`, `pages`, `blogs`, `articles`). Only fields on the fixed list per type are asked for. |
| `adapters[].urls`               | Where a type's pages live, when you want a pattern instead of the address Shopify gives. Only `{slug}` and `{id}` are filled in.         |

| Environment variable       | What it is                                                             |
| -------------------------- | ---------------------------------------------------------------------- |
| `SHOPIFY_STOREFRONT_TOKEN` | The Storefront API access token (read-only by design).                 |
| `SHOPIFY_SHOP_DOMAIN`      | The store's `myshopify.com` address.                                   |
| `SHOPIFY_API_VERSION`      | Optional. A quarterly release such as `2026-10`, which is the default. |
