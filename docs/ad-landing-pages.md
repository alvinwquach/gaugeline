# Ad landing pages

Check every page your ads send people to: broken, sold out, or losing the campaign on the way.

Paid clicks are the most expensive visitors you get. Export your ads from Meta Ads Manager or Google Ads, keep the link and amount-spent columns, and point Gaugeline at the file.

```sh title=Terminal untested="Converted with a fixture in this page's own branch."
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

## In the app

```sh title=Terminal untested="gaugeline open runs until Ctrl+C, and the ads command it reads is built after the app: open-ads.test.ts runs the flag against a stand-in for it."
$ npx gaugeline open --ads tapas-bar-autumn-ads.csv
```

Say you built a tapas bar's site on Sanity, Next.js and Vercel, and the owner runs a Meta campaign
for the autumn menu: 12 ads, four landing pages, one of them the old menu you took down in
September. Export the ads from Ads Manager, keep the link and amount-spent columns, and open the
file in the app. The Ads view starts with the sentence the owner wants, how much of the spend went
to pages with problems, and lists the pages, the worst first:

![The Ads view for the tapas bar: $1,150.74 of $3,155.24 went to pages with problems, and four landing pages with their ads, spend and findings.](/img/app-ads.png)

```text title=Ads in the app
$1,150.74 of $3,155.24 went to pages with problems.

Landing page                            Ads      Spend  Findings
https://tapas-bar.example/old-menu        1    $999.99  The page doesn't load
https://tapas-bar.example/gift-cards      3    $150.75  Campaign tags are lost
https://tapas-bar.example/happy-hour      5  $1,204.50  None
https://tapas-bar.example/book-a-table    3    $800.00  None
```

- **Sorted by spend on pages with problems**, highest first. Pages with nothing wrong follow, by
  how much was spent on them. **Only pages with problems** hides the rest. When none has a problem
  the summary says no spend went to pages with problems, and the table still lists every page.
- **Each finding opens in Problems**, with why it matters and how to fix it, and can be copied as a
  note: for the old menu, the note to send the freelancer's client is one click.
- **Nothing is uploaded.** The app reads the file once, from the path you typed, and shows only the
  file's name. Ad names and amounts stay on your computer: the only requests are one GET or HEAD for each
  landing page, through the same fetcher as any other check, five at a time at most.
- **Money is exact.** Spend is added as whole cents (or yen) and formatted at the end. If the export
  mixes currencies, each gets its own summary and table; they are never added together.
- **Download the report** is offered when the ads command makes one for the run, and hidden otherwise.

::: warning Not in this version yet
The app's Ads view is built, but reading an export and checking its pages is the ads command, which comes
after it. Until then `gaugeline open --ads` exits with code 2 and says so. The example above is what the
view shows for these figures, made by the same code as the app.
:::

::: info
Apps like AdStockGuard and Guardified pause ads automatically when stock hits zero. Gaugeline reports; those act. They work well together.
:::
