# Products and prices

Compare what your website shows, what checkout charges and what fulfillment makes.

The same product usually lives in three places: Sanity (your website), Stripe (checkout) and Printful (fulfillment). Nothing keeps them in agreement, so prices drift, products get archived in one place and not the others, and duplicates pile up. Gaugeline reads all three and explains every disagreement.

```sh title=Terminal untested="Converted with a fixture in this page's own branch."
$ SANITY_PROJECT_ID=abc123 SANITY_TOKEN=… STRIPE_API_KEY=rk_live_… PRINTFUL_API_TOKEN=… npx gaugeline open yoursite.com
```

| System   | Variable                                              | Use a key that can only                                                                       |
| -------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Sanity   | `SANITY_PROJECT_ID`, `SANITY_DATASET`, `SANITY_TOKEN` | Read. **A private dataset needs a read-only token** (Viewer role); a public one works without |
| Stripe   | `STRIPE_API_KEY`                                      | Read products and prices. Create a restricted key; never use your secret key                  |
| Printful | `PRINTFUL_API_TOKEN`, `PRINTFUL_STORE_ID`             | Read store products                                                                           |

<!-- diagram: systems (drawn on the landing page; not reproduced here) -->

- **If you own the site:** If your website and your checkout disagree about a price, customers see one number and pay another. This finds that in one run.
- **If you run marketing:** A sold-out or archived product still being advertised is money leaving every hour.
- **If you edit content:** You'll see which product is wrong and where, in plain words.
- **If you build the site:** Read-only keys, matched by saved IDs first, then SKU, then name. Set GAUGELINE_PRODUCTS_QUERY for a custom schema.

## How products are matched

1. By the Stripe or Printful ID saved on the Sanity product, if there is one.
2. By a sanityId in the Stripe product's metadata, or the Printful product's external ID.
3. By SKU.
4. By name, ignoring case and punctuation.

Your products live under a different type or field names? Set `GAUGELINE_PRODUCTS_QUERY` to a GROQ query that returns `_id`, `name`, `price`, `sku`, `stripeId` and `printfulId`. If your prices are stored in cents, set `GAUGELINE_SANITY_PRICE_UNIT=cents`.

## Reading Sanity

Sanity is read through the query endpoint of the project, with one `GET` for the products and, when asked, two small ones for a count per document type. Nothing is ever written.

| Variable                      | Needed | What it does                                                                                         |
| ----------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `SANITY_PROJECT_ID`           | Yes    | The project, as shown in sanity.io/manage. It is the only variable Sanity needs to be read           |
| `SANITY_DATASET`              | No     | The dataset. When it is not set, `production` is assumed and the run says so                         |
| `SANITY_TOKEN`                | No     | A token with the **Viewer** role. A public dataset works without one; a private one does not         |
| `GAUGELINE_PRODUCTS_QUERY`    | No     | A GROQ query that replaces the default one (below)                                                   |
| `GAUGELINE_SANITY_PRICE_UNIT` | No     | `cents` when your prices are already whole minor units. Anything else, or nothing, means major units |

What is asked:

- **Published documents only.** Every request carries `perspective=published`, so a draft price nobody has published is never compared with checkout. The cost is that you cannot use this to preview a change before publishing.
- **The default query** reads every document of type `product` and returns `_id`, `name`, `price`, `sku`, `stripeId` and `printfulId`.
- **A custom query** (`GAUGELINE_PRODUCTS_QUERY`) must return a list of objects with `_id` and `name` on every row. `price`, `sku`, `stripeId` and `printfulId` may be left out. GROQ projections rename fields for you: `*[_type == "menuItem"]{_id, "name": title, "price": priceGbp}`. A row without `_id` or `name` is refused, and the message names the field and how many rows lack it. The query travels in the address of a `GET`, so keep it under about 8,000 characters.
- **Prices** are whole numbers of minor units. In major units (the default), `48` and `"48.00"` are 4800 and `19.99` is 1999: the text of the price is split at the point, never multiplied. A product with no price, a price that is not a plain amount (`"free"`, `48.123`) or a negative one has the price `null` and is still returned. With `GAUGELINE_SANITY_PRICE_UNIT=cents`, `48` stays 48, and a value that is not a whole number of cents is `null`.
- **Counts of types.** `typeCounts` returns how many published documents each `_type` has, nothing from inside a document. It asks for the type names, then for one count per name.
- **Zero products and no token** can mean an empty dataset or a private one that answers an empty list. If you expected products, set `SANITY_TOKEN`.

### What a private dataset needs

When Sanity answers 401 or 403, the run says that a private dataset needs a read-only token with the Viewer role (see [Private datasets](/docs/private-datasets)), and the other systems are still read. A token that can write is used as it is, with one notice recommending the Viewer role. The role is read with one `GET` of the token's own user; only the role names are kept, and an answer that cannot be read gives no notice.

### Example: a pop-up kitchen's menu in Sanity

Ember Supper Club is a pop-up kitchen. Its freelancer keeps the menu items in Sanity and set only `SANITY_PROJECT_ID`, because the dataset is public and still called `production`. The site shows each item's price; Gaugeline reads the same items from Sanity so it can compare them with the page. Against an invented recording of the project (`packages/testkit/cassettes/sanity-products.json`), one run of the Sanity connector returns these products and this notice:

```json title=Products
[
  {
    "_id": "tasting-box",
    "name": "Tasting box for two",
    "price": 4500,
    "sku": "EMB-TASTE",
    "stripeId": "prod_EmberTasting1"
  },
  {
    "_id": "supper-ticket",
    "name": "Supper club ticket",
    "price": 4800,
    "sku": "EMB-SUPPER",
    "stripeId": "prod_EmberSupper02"
  },
  {
    "_id": "hot-sauce",
    "name": "Ember hot sauce",
    "price": 1999,
    "sku": "EMB-SAUCE"
  },
  {
    "_id": "apron",
    "name": "Ember apron",
    "price": null,
    "printfulId": "pf-apron-7"
  },
  {
    "_id": "gift-card",
    "name": "Gift card",
    "price": 0
  }
]
```

```json title=Advice
[
  {
    "connector": "sanity",
    "kind": "advice",
    "message": "SANITY_DATASET is not set, so the dataset \"production\" was assumed. Set it if your products live in another dataset."
  }
]
```

The tasting box is stored as `45`, the supper ticket as the text `"48.00"` and the hot sauce as `19.99`; all three come out as whole cents. The apron has no price in Sanity, so its price is `null` and it is never reported as a mismatch. Both outputs are asserted by `packages/core/src/connectors/__tests__/docs.test.ts`.

## What it can't decide for you

Gaugeline can tell you two systems disagree. It can't tell you which one is right. Decide which system owns each fact, usually checkout for prices, and have the others read from it.

::: info
Keys stay on your computer, are only read from environment variables, and are never printed or saved. If one system can't be reached, the rest of the check still runs.
:::

## How keys are handled

- A key is read from the environment variable named in the table above, and from nowhere else. There is no config file entry, no flag and no prompt that accepts one, so a key cannot end up in a file you commit or a command you paste into a chat.
- A variable that is not set, or is set to an empty string, means that system is left out. That is a notice in the run, never an error, and nothing is requested from it.
- Every request to a system is a `GET` with the key in an `Authorization` header, never in the address. A redirect to a different site is followed without the header.
- Everything Gaugeline prints about a system (a notice, an error, a `--verbose` line) first has every key value replaced by `[redacted]`, including the percent-encoded and JSON-escaped forms and longer keys that contain a shorter one.
- If one system can't be reached or refuses the key, the others are still read and the site check still runs. The run says which system gave no answer and why.

## In this version: the connector interface

The three systems above are read through one small interface, `Connector`. This version ships the interface, the runner, the key handling and the Sanity reader ([below](#reading-sanity)). The Stripe and Printful readers arrive next, each as a connector, so nothing is requested from them today.

A connector has an `id`, the names of the variables it needs (`envVars`), a `configured` test and a `read` that returns a list. It may also list variables it reads when they are set (`optionalEnvVars`), say which of its variables are keys (`secretEnvVars`, so only those are blanked in messages), and give advice (`advise`). `runConnectors` reads every configured connector at the same time and returns two things: `data`, the rows by connector id, and `notices`, one for every system that gave none, and any advice.

| Notice kind      | When                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `not-configured` | A variable is missing or empty. Nothing was requested.                                                       |
| `refused`        | The system answered 401 or 403: it knows the key and will not let it read.                                   |
| `unreachable`    | No answer in time, an answer the connector could not use, or any other failure while reading.                |
| `advice`         | The read may have worked. Something is worth changing: an assumed default, a key that can do more than read. |

### Example: a pop-up kitchen with prices in three systems

Ember Supper Club is a pop-up kitchen. Its tasting box is priced on the Sanity website, in Stripe checkout and in Printful (for the printed apron that comes with it). The freelancer who runs the site has set the Sanity variables, pasted a Stripe key that turns out to be for the wrong account, and not yet created a Printful token. With the three stand-in connectors (one answering as Sanity, one as a Stripe that answers 401, one with a missing token), `runConnectors` returns data for Sanity only and these notices:

```json title=Notices
[
  {
    "connector": "stripe",
    "kind": "refused",
    "message": "stripe refused the key (HTTP 401). Check it is the right key and that it can read."
  },
  {
    "connector": "printful",
    "kind": "not-configured",
    "message": "printful is not set up, so it was left out. Set PRINTFUL_API_TOKEN to include it."
  }
]
```

The Stripe key is not in the message, although the stand-in's server echoed it back in its error. The output is asserted by `packages/core/src/connectors/__tests__/docs.test.ts`.

## In this version: the free price agreement check

`npx gaugeline-free price <product-url>` reads three prices for one product page, all as whole
numbers of cents:

| Price        | Read from                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| On the page  | The theme's price element, as sent without JavaScript. "From $48" is read as 48.00 and marked a starting price                             |
| Product data | The JSON-LD `Product` offer search engines read: its `price` and `priceCurrency` (with several offers, the one for the page's `?variant=`) |
| Charged      | On a Shopify store only: the variant's price in the public product JSON, `/products/<handle>.js`. One extra GET, no key                    |

Any two that differ are reported, compared on the ones that exist. A currency on the page that
differs from the product data's is reported too, and amounts are never converted. "In stock" in the
product data for a product that can't be bought (sold out in the product JSON, or a disabled or
"Sold out" add-to-cart button) is reported as well. Nothing else is requested.

Against the invented `price-stores` fixture, a pottery shop whose mug says 48.00 on the page and in
the product data but charges 52.00, `gaugeline-free price <origin>/products/mug` prints:

```text title=Output
✗ This product's prices disagree
    the page shows 48.00 but the store charges 52.00; the product data says 48.00 but the store charges 52.00

1 to look at, 1 to fix first.
```

The output is asserted by `packages/free/src/__tests__/free.test.ts`.
