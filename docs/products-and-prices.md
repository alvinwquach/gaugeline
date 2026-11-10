# Products and prices

Compare what your website shows, what checkout charges and what fulfillment makes.

The same product usually lives in three places: Sanity (your website), Stripe (checkout) and Printful (fulfillment). Nothing keeps them in agreement, so prices drift, products get archived in one place and not the others, and duplicates pile up. Gaugeline reads all three and explains every disagreement.

```sh title=Terminal untested="Converted with a fixture in this page's own branch."
$ SANITY_PROJECT_ID=abc123 SANITY_TOKEN=… STRIPE_API_KEY=rk_live_… PRINTFUL_API_TOKEN=… npx gaugeline open yoursite.com
```

| System   | Variable                                              | Use a key that can only                                                                               |
| -------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Sanity   | `SANITY_PROJECT_ID`, `SANITY_DATASET`, `SANITY_TOKEN` | Read. **A private dataset needs a read-only token** (Viewer role); a public one works without         |
| Stripe   | `STRIPE_API_KEY`                                      | Read products and prices. **A restricted key only**; a secret key is refused ([how](#reading-stripe)) |
| Printful | `PRINTFUL_API_TOKEN`, `PRINTFUL_STORE_ID`             | Read store products. **A token that can only view them** ([which](#choose-the-narrowest-token))       |
| Shopify  | `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_SHOP_DOMAIN`         | Read products. **The `read_products` scope only** ([how](/docs/sources/shopify))                      |
| Square   | `SQUARE_ACCESS_TOKEN`                                 | Read the item catalogue. **The `ITEMS_READ` permission only** ([how](/docs/sources/square))           |

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

## Reading Stripe

Stripe is read with two lists, both `GET`: the products, then the prices, 100 at a time. Nothing is ever written, and Gaugeline never asks Stripe for a price one product at a time: it joins the two lists in memory, so a store with 250 products costs about six requests.

| Variable         | Needed | What it does                                                                                                  |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `STRIPE_API_KEY` | Yes    | A **restricted** key (it starts `rk_live_` or `rk_test_`) that can read products and prices, and nothing else |

What is asked:

- **Two read endpoints, and only these:** `GET /v1/products` ([list products](https://docs.stripe.com/api/products/list)) and `GET /v1/prices` ([list prices](https://docs.stripe.com/api/prices/list)). The narrowest key that can call them is a restricted key with Read on Products and Prices ([below](#create-the-narrowest-key)).
- **Both lists, archived included.** Products and prices are requested without an `active` filter, so an archived product or price comes back with `active: false`. That is data: a page that still sells an archived product is a finding for the checks that arrive next.
- **The documented cursor.** Each list follows `has_more` by asking again with `starting_after` set to the last id, until Stripe says there is no more. At most 50 pages of 100 are read per list; if the cap is reached, the run says so in one notice and keeps what it read. A page that is empty while `has_more` is true, or the same page twice, stops the list with a notice instead of looping.
- **What is kept.** Per product: `id`, `name`, `active`, `metadata` (text values only), `defaultPriceId` and its `prices`. Per price: `id`, `unitAmount`, `currency` and `active`. A price with no fixed amount (tiered or metered pricing) keeps `unitAmount: null`; it is never turned into 0. A product with no default price has `defaultPriceId: null` and still lists every price it has. Descriptions, images and customer data are not kept.
- **The key goes in a header.** Every request carries `Authorization: Bearer <key>`, never the address.

### Which keys are accepted

| Key starts with           | What happens                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `rk_live_`, `rk_test_`    | Used. This is the key to create.                                                                                                   |
| `sk_live_` (or any `sk_`) | **Refused before anything is requested.** Gaugeline exits 2 and says to create a restricted key that can read products and prices. |
| `sk_test_`                | Used, with one notice: a test-mode secret key can only touch test data, but a restricted key is the better habit.                  |
| Anything else             | Used as it is, with one notice that it does not look like a restricted key. Stripe will say if it does not accept it.              |

A secret key can do everything on your Stripe account, including moving money. Gaugeline only reads, but a key that can do more than read is one leak away from a worse day, so the default is to refuse it and say what to make instead. If you have read that and still want to use one, `--allow-secret-key` turns the refusal into a notice. The key is never printed in the message, the report or the JSON.

```text title=Output
STRIPE_API_KEY is a Stripe secret key, which can do far more than read. Create a restricted key that can read products and prices, set STRIPE_API_KEY to it and run again.
Try: The steps are in docs/products-and-prices. To use the secret key anyway, pass --allow-secret-key.
```

### Create the narrowest key

Read-only on Products and Prices, and nothing else:

1. In the Stripe Dashboard, open Developers, then API keys, then **Create restricted key**.
2. Name it something you will recognise, such as `Gaugeline (read only)`.
3. Under the core resources, set **Products** to **Read** and **Prices** to **Read**. Leave every other permission at **None**.
4. Create the key and copy it. Stripe shows it once. It starts `rk_live_` (or `rk_test_` in test mode).
5. Put it in the environment, not in a file: `STRIPE_API_KEY=rk_live_… npx gaugeline open yoursite.com`.

The menu names in these steps are from memory: Stripe's documentation was not reachable when this page was written, so they are uncited. Check them against [Stripe's page on API keys](https://docs.stripe.com/keys).

If the key is missing a permission, Stripe answers 403 and the run names the one to add (below). If Stripe does not accept the key at all (401), the run says to check it is a restricted key from the right account.

### Example: a pop-up kitchen's tamal box

La Olla Pop-Up is a pop-up kitchen. Its freelancer built the site on Next.js and Sanity, with checkout in Stripe. The site says the tamal box costs **$42.00**. The freelancer created a restricted key with Read on Products and Prices only and set `STRIPE_API_KEY`. Against an invented recording of the account (`packages/testkit/cassettes/stripe-products.json`), the Stripe connector returns these two of the five products:

```json title=Stripe products
[
  {
    "id": "prod_PopTamalBox",
    "name": "Tamal box (a dozen)",
    "active": true,
    "metadata": {
      "sanityId": "tamal-box"
    },
    "defaultPriceId": "price_TamalBox4800",
    "prices": [
      {
        "id": "price_TamalBox4800",
        "unitAmount": 4800,
        "currency": "usd",
        "active": true
      },
      {
        "id": "price_TamalBox4200",
        "unitAmount": 4200,
        "currency": "usd",
        "active": false
      }
    ]
  },
  {
    "id": "prod_PopFlight",
    "name": "Tasting flight, per guest",
    "active": true,
    "metadata": {},
    "defaultPriceId": "price_FlightTiers",
    "prices": [
      {
        "id": "price_FlightTiers",
        "unitAmount": null,
        "currency": "usd",
        "active": true
      }
    ]
  }
]
```

Checkout charges 4800 cents, $48.00, for the tamal box. The $42.00 on the page is the old price, still in Stripe as an archived one: the price went up in Stripe and the page was never updated, so customers see one number and pay another. This version reads both sides; the price checks that compare them arrive in a later release. The tasting flight has a tiered price, so its amount is `null` and no mismatch can be made of it. The supper club seat (not shown) has no default price and three prices, so its `defaultPriceId` is `null` and all three are listed.

The same account with a key that can read products but not prices stops at the prices, and the run says which permission to add:

```json title=Stripe notices
[
  {
    "connector": "stripe",
    "kind": "refused",
    "message": "stripe refused the key (HTTP 403). STRIPE_API_KEY cannot read Prices. In Stripe, edit the restricted key and set Prices to Read; nothing else is needed."
  }
]
```

Both outputs are asserted by `packages/core/src/connectors/__tests__/docs.test.ts`.

### A live site on a test key

The check `stripe-test-mode` needs no key at all. It looks in the page and in the same-site scripts the run already read for a Stripe test publishable key (`pk_test_`) and reports it on any address that is not a hosting provider's preview (`vercel.app`, `netlify.app`, `pages.dev`), where a test key is expected. It sends no request of its own, and the key is shown by its first six and last two characters only. A checkout built on a test key looks fine and takes no real money.

Against the invented `stripe-test-mode` fixture, La Olla Pop-Up's site as it was handed over (a test key in the page, another in the checkout script), version 0.1.0 prints:

<!-- fixture: stripe-test-mode -->

```sh title=Terminal
$ npx gaugeline shop.example
```

```text title=Output
✗ This live site is using Stripe's test key
    Stripe test key pk_tes…00 in the HTML of /
✗ This live site is using Stripe's test key
    Stripe test key pk_tes…K7 in /checkout.js
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 to look at, 2 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by `pnpm docs:examples` in CI. To fix it, switch Stripe to live mode, put the live publishable key (`pk_live_`) where the site reads its key, redeploy, and place one small real order.

## Reading Printful

Printful is read with a list of the store's products, then one request per product for its variants. Every request is a `GET`; nothing is ever written, ordered or synced.

| Variable             | Needed | What it does                                                                                   |
| -------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `PRINTFUL_API_TOKEN` | Yes    | A private token that can only view the store's products ([below](#choose-the-narrowest-token)) |
| `PRINTFUL_STORE_ID`  | Yes    | The number of the store, such as `1234567`. It is sent as the store header on every request    |

If either variable is missing or empty, Printful is left out with a notice that names the missing one, and the other systems are still read. That is "could not check", never "all fine".

What is asked:

- **Two read endpoints, and only these:** `GET /store/products` (the list) and `GET /store/products/{id}` (one product, with its `sync_variants`). The list has no variants, which is why the second request exists. The endpoint names are from [Printful's API documentation](https://developers.printful.com/docs/), which was not reachable when this page was written, so they are from memory and uncited. Check them there.
- **The list** is asked with `offset` and `limit=100` and followed until the total it reports is reached or a page comes back empty, so a store whose size changes while it is read cannot loop. If the shop holds back fewer than 100 a page, the offset moves by what came. At most 50 pages are read.
- **The variants** are fetched five products at a time, at most **200 products per run**. Printful limits how fast it answers, and the number of requests grows with the catalogue, so a fixed budget keeps a run predictable. Past it, the run returns the 200 it read and one notice says how many it skipped. A store of 260 products reads 200 and says it skipped 60.
- **What is kept.** Per product: `id`, `externalId` (the id your shop gave it, when Printful holds one) and `name`. Per variant: `id`, `sku` (left out when Printful has none, never an empty string), `synced`, `retailPrice` and `currency`. Names of variants, images, files and customer orders are not kept.
- **Prices** are whole numbers of minor units. Printful sends a decimal string: `"24.50"` and `"24.5"` are both 2450 (the text is split at the point, never multiplied). An empty price, or one that is not a plain amount, is `null`: no price, not a free one.
- **`synced: false`** is kept as it is. A variant that is not synced has a design that is not matched to a printable item, so an order for it cannot be made. A product with no variants is returned with an empty list.
- **Headers, not addresses.** Every request carries `Authorization: Bearer <token>` and the store number in the `X-PF-Store-Id` header. Neither is ever in the address.

### What the errors mean

| Printful answers                           | The run says                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 401                                        | The token is wrong or has been revoked. Create a new one.                                                                     |
| 403 or 404 on the store                    | The token cannot see that store number. Check `PRINTFUL_STORE_ID` belongs to the store the token was made for.                |
| 429 with a `Retry-After` of 60 s or less   | Gaugeline waits that long and asks once more. A second 429 gives up with an "unreachable" notice that says when to try again. |
| 429 with no `Retry-After`, or a longer one | Gives up at once with the same notice. Gaugeline does not guess how long to wait.                                             |
| A product removed during the run           | It is left out and one notice counts them.                                                                                    |

The 200-request budget and the single retry are proposed, not Printful's rules.

### Choose the narrowest token

Printful tokens are created in the Printful Developer Portal and carry **scopes**, the list of things the token is allowed to do. Gaugeline needs one thing: to view the store's products and their variants. So:

1. Create a private token for the one store you want read, and name it something you will recognise, such as `Gaugeline (read only)`.
2. Tick the scope that lets the token **view** store (sync) products, and nothing else. Leave every scope that says manage, edit, create or write unticked, and leave orders, files, webhooks and shipping unticked.
3. Copy the token. Put it in the environment, not in a file: `PRINTFUL_API_TOKEN=… PRINTFUL_STORE_ID=1234567 npx gaugeline open yoursite.com`.

The scope names and where to find them are not stated here: Printful's documentation was not reachable when this page was written, so the exact wording of the scope is uncited. If the portal only offers one scope for store products and it includes managing them, pick it and keep that token for Gaugeline alone, so it can be revoked on its own; Gaugeline will still only send `GET` requests.

### Example: a coach's merch in three places

Ridgeline Strength Coaching sells a logo tee, a training hoodie, a water bottle and a gym tote to clients who train with the coach. The freelancer who built the site on Next.js and Sanity set up checkout in Stripe and fulfilment in Printful. The page says the hoodie costs **$54.00** and Stripe charges $54.00, but a client wrote to say the large hoodie never shipped. The freelancer created a view-only Printful token and set `PRINTFUL_API_TOKEN` and `PRINTFUL_STORE_ID`. Against an invented recording of the store (`packages/testkit/cassettes/printful-merch.json`), the Printful connector returns these two of the five products:

```json title=Printful products
[
  {
    "id": "5002",
    "externalId": "ridgeline-hoodie",
    "name": "Training hoodie",
    "variants": [
      {
        "id": "70021",
        "sku": "RL-HOOD-M",
        "synced": true,
        "retailPrice": 5400,
        "currency": "USD"
      },
      {
        "id": "70022",
        "sku": "RL-HOOD-L",
        "synced": false,
        "retailPrice": 5850,
        "currency": "USD"
      }
    ]
  },
  {
    "id": "5003",
    "externalId": "ridgeline-bottle",
    "name": "Steel water bottle",
    "variants": [
      {
        "id": "70031",
        "synced": true,
        "retailPrice": null,
        "currency": "USD"
      }
    ]
  }
]
```

The large hoodie is **not synced**: its design was never matched to a printable item, which is why it never shipped. Its retail price in Printful is also $58.50, while the medium (and the page, and Stripe) say $54.00, so a customer who picked large would see one number and, if the order went through, be sent another. This version reads all three systems; the checks that compare them arrive in a later release. The water bottle has an empty retail price in Printful, so its price is `null` and no mismatch can be made of it, and it has no SKU. The programme poster (not shown) is a draft with no variants and comes back with an empty list.

If the freelancer had typed the wrong store number, Printful would refuse it and the run would say so, while Sanity and Stripe are still read:

```json title=Printful notices
[
  {
    "connector": "printful",
    "kind": "refused",
    "message": "printful refused the key (HTTP 403). PRINTFUL_API_TOKEN cannot see store 2718281. Check PRINTFUL_STORE_ID is the number of a store this token was made for, and that the token can view store products (the narrowest read-only choice is in docs/products-and-prices)."
  }
]
```

Both outputs, and the prices in this example, are asserted by `packages/core/src/connectors/__tests__/docs.test.ts`.

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

The three systems above are read through one small interface, `Connector`. This version ships the interface, the runner, the key handling, the Sanity reader ([above](#reading-sanity)), the Stripe reader ([above](#reading-stripe)), the Printful reader ([above](#reading-printful)) and the [Shopify](/docs/sources/shopify) and [Square](/docs/sources/square) readers, which return the same catalogue shape. Nothing in a normal run requests Stripe, Printful, Shopify or Square yet: the comparisons that use them come with the price checks.

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
