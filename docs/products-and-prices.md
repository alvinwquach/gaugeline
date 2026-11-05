# Products and prices

Compare what your website shows, what checkout charges and what fulfillment makes.

The same product usually lives in three places: Sanity (your website), Stripe (checkout) and Printful (fulfillment). Nothing keeps them in agreement, so prices drift, products get archived in one place and not the others, and duplicates pile up. Gaugeline reads all three and explains every disagreement.

```sh title=Terminal
$ SANITY_PROJECT_ID=abc123 SANITY_TOKEN=… STRIPE_API_KEY=rk_live_… PRINTFUL_API_TOKEN=… npx gaugeline open yoursite.com
```

| System   | Variable                                              | Use a key that can only                                                         |
| -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| Sanity   | `SANITY_PROJECT_ID`, `SANITY_DATASET`, `SANITY_TOKEN` | Read. **A private dataset needs a read-only token**; a public one works without |
| Stripe   | `STRIPE_API_KEY`                                      | Read products and prices. Create a restricted key; never use your secret key    |
| Printful | `PRINTFUL_API_TOKEN`, `PRINTFUL_STORE_ID`             | Read store products                                                             |

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

## What it can't decide for you

Gaugeline can tell you two systems disagree. It can't tell you which one is right. Decide which system owns each fact, usually checkout for prices, and have the others read from it.

::: info
Keys stay on your computer, are only read from environment variables, and are never printed or saved. If one system can't be reached, the rest of the check still runs.
:::
