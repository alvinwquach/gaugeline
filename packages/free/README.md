# gaugeline-free

Free tools from [Gaugeline](https://github.com/alvinwquach/gaugeline): no keys, no account. Each one
reads public pages the way a search engine does (GET and HEAD only), writes a report you can forward
(`gaugeline-report.html`), and exits 1 with `--ci` (or `CI` set) when something serious turns up.

```bash
npx gaugeline-free price https://yourshop.example/products/mug
npx gaugeline-free launch yoursite.example
npx gaugeline-free study stores.txt
```

| Command               | What it does                                                                                                                                                                                       | Status |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `price <product-url>` | Price agreement check: the price a visitor sees, the price in the product data Google reads, and the price Shopify will actually charge; and "in stock" to Google when the product can't be bought | New    |
| `launch <site>`       | Launch-day check: `gaugeline launch` with the mail record lookups (SPF and DMARC)                                                                                                                  | New    |
| `study <stores.txt>`  | How often does a store disagree with itself? The price check across a list of product pages, one site at a time, with totals. `--json` prints the rows                                             |        |

Every rule lives in the Gaugeline engine; this package only parses arguments and picks what to run.
See [Products and prices](https://github.com/alvinwquach/gaugeline/blob/main/docs/products-and-prices.md)
for how the three prices are read.
