# Ad landing pages

Check every page your ads send people to: broken, sold out, or losing the campaign on the way.

Paid clicks are the most expensive visitors you get. Export your ads from Meta Ads Manager or Google Ads, keep the link and amount-spent columns, and point Gaugeline at the file.

```sh title=Terminal
$ npx gaugeline ads ads-export.csv
$ npx gaugeline open --ads ads-export.csv   # the same, in the app
```

- **If you own the site:** You'll see, in dollars, how much of last month's ad spend went to pages that couldn't sell anything.
- **If you run marketing:** The redirect that strips utm_source is the one to fix first: those sales are landing in your reports as unattributed.
- **If you edit content:** Nothing to do here; this one is for whoever runs the ads.
- **If you build the site:** Shopify stock is read from the public product endpoint, so no keys are needed for sold-out detection.

## What it checks

| Check                  | What it means                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------- |
| The page doesn't load  | Everyone clicking that ad lands on an error.                                          |
| Campaign tags are lost | A redirect drops `utm_*`, `gclid` or `fbclid`, so the ad looks like it isn't working. |
| Sold out               | On Shopify, the advertised product can't be bought right now.                         |
| Theme placeholders     | The landing page still shows sample content.                                          |

## Reading the summary

Ads that share a destination are checked once and their spend is added together, so the total tells you how much went to pages with problems.

::: info
Apps like AdStockGuard and Guardified pause ads automatically when stock hits zero. Gaugeline reports; those act. They work well together.
:::
