# Ad landing pages

Check every page your ads send people to: broken, sold out, or losing the campaign on the way.

Paid clicks are the most expensive visitors you get. Export your ads from Meta Ads Manager or Google Ads, keep the link and amount-spent columns, and point Gaugeline at the file.

```sh title=Terminal untested="ads-export.csv is your own file. The example under Export your ads runs the same command on an invented export."
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

## Export your ads

Say you built a tapas bar's site on Sanity, Next.js and Vercel, and the owner runs a Meta campaign
for the autumn menu. Ask for the export, or take it yourself from the ad account:

- **Meta Ads Manager:** show the **Website URL** and **Amount spent** columns, then export the table as CSV.
- **Google Ads:** show the **Final URL** and **Cost** columns (and **Currency code** if the account is
  not in one currency), then download the report as CSV. Choose plain CSV, not the Excel one that uses tabs.

Gaugeline only reads the two columns it needs, plus the ad's name and a currency column when there is one.
The other columns can stay. The file never leaves your computer: Gaugeline asks each landing page for
itself, once, and no ad name or amount is sent to anyone.

```sh title=Terminal untested="Reads a file, not a site, so the docs runner cannot point it at a fixture. packages/cli/src/__tests__/ads-docs.test.ts runs this command against packages/fixtures/ads/meta.csv, with the gift cards page answering as an old redirect rule would, and compares the output with the block below."
$ npx gaugeline ads meta.csv
```

```text title=Output
Read 12 ads that go to 4 landing pages
Following the campaign tags through 4 landing pages
https://tapas-bar.example/happy-hour    5 ads  1204.50 USD
https://tapas-bar.example/old-menu       1 ad   999.99 USD
https://tapas-bar.example/book-a-table  3 ads   800.00 USD
https://tapas-bar.example/gift-cards    3 ads   150.75 USD

✗ Campaign tags are lost
    At hop 1, the 301 from https://tapas-bar.example/gift-cards to https://tapas-bar.example/shop/gift-cards drops utm_source, utm_medium, utm_campaign. 3 ads send people to this page, with 150.75 USD spent on it.

1 to look at, 1 to fix first.
```

The first two lines go to stderr, so a redirect (`> pages.txt`) keeps the four lines and what was found. Each
line is a landing page, the number of ads that send people to it and what was spent on it, highest first
and then by address. The 12 ads in this invented export go to four pages. Under them is what the checks found,
with its spend, and nothing at all when they found nothing. Add `--json` for the result as JSON (schema 2).
Add `--allow-private` to check a site on your own computer or network.

### Which columns it reads

Names are matched without regard to capitals or punctuation, and only whole names count: "Link clicks"
is not a link column, and "Cost per result" is not the spend.

| What         | Columns it accepts                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Link         | Link, Website URL, Final URL, Final URLs, Destination, Destination URL, Landing page, Landing page URL, Link URL, URL (in that order) |
| Amount spent | Amount spent, Spend or Cost, with or without a currency in brackets, as in "Amount spent (USD)"                                       |
| Currency     | Currency or Currency code; without one, the code in brackets after the spend column's name                                            |
| Ad name      | Ad name, Ad, Name or Creative name                                                                                                    |

A title or a date range above the table (Google adds both) is skipped, and so are the **Total:** rows
under it. A row with no link, or a link that is not a web address (`mailto:`, `ftp://`), is skipped and
counted in a warning. A link without `https://` is read as `https://` and a warning says so.

### How spend is read

Spend is stored as whole cents (or yen, or fils), never as a decimal number, so totals are exact.
`$1,204.50`, `1204.5` and `€ 48` read as you would expect. A blank spend counts as 0 and the ad still
counts towards its page. `1.204,50` is read as 1204.50 and a warning calls it ambiguous, because a
comma may also be a thousands mark; `12.345` in a currency with two places is not rounded: it counts
as 0 and a warning names the line. If the file has two currencies, each page lists both
(`40.00 EUR + 25.00 USD`) and they are never added together.

## How ads are grouped

Forty ads often share four landing pages, so Gaugeline groups first. Ads that share a destination are
checked once and their spend is added together. Two ads share a destination when their links are the
same after this is done:

1. `utm_` anything, `gclid` and `fbclid` are removed. The tags are what differs between ads that send
   people to one page, so they must not split it. Each ad's own tag values are kept for the check that
   follows, which asks whether they survive the click.
2. The part after `#` is removed.
3. The host is written in lower case.
4. The rest of the query is sorted, so `?size=l&colour=red` and `?colour=red&size=l` match.

Nothing else is changed. In particular **`/menu` and `/menu/` are two destinations**: some servers treat
them as different pages, and one of them may redirect, which is the hop worth finding. `http` and
`https` are two destinations for the same reason.

## Campaign tags are lost

An ad link carries tags: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` (and any
other `utm_` key), plus `gclid` from Google Ads and `fbclid` from Meta. They are how your analytics learns
which ad a visit came from. A redirect on the way to the page, an old rule for a page that moved or a
short link that was built by hand, often forgets to pass the query on, and the visit arrives with no sign of
the ad that paid for it.

For each landing page, Gaugeline asks for the address once, with the tags of one of its ads (the first ad
that has any), and follows every redirect. It compares the tags on the first address with the last:

- Order does not matter, and `%20` against `+` is the same value. A tag that comes back with a different
  value counts as lost, because the report would no longer say what the ad said.
- When a tag is lost, the finding names the first redirect that no longer carries it: its number in the
  chain, its status, the address it left and the address it went to, and the tags it dropped. It also gives
  the number of ads that send people there and the spend behind them, in each currency, never added together.
- A redirect to another host that keeps the tags is fine. A page with no redirect is fine.
- A redirect that moves the tags to the part of the address after `#` is lost, and the finding says so:
  servers never see that part, so it never reaches your analytics.
- If no ad that links to a page carries any tag, Gaugeline asks with `utm_source=gaugeline-check` and
  `gclid=test` so the question can still be answered. The finding says these are Gaugeline's, not yours.
- A page that answers 404 at the end still gets its tag verdict. Whether the page itself loads is a
  separate check.
- A page that could not be reached, or whose redirects went on in a loop, is listed as not checked. It is
  never reported as fine.

Gaugeline follows redirects only. It does not run the page's JavaScript, so a script that rewrites the
address after the page has loaded is out of scope. Every request is a GET, five at a time at most.

To fix it, make the redirect pass the query string on, or point the ad straight at the final address.

### One link: `gaugeline tags`

Paste a single link to see the same thing for it: one line for each hop with the tags still on it, then
one verdict. Say a freelancer is handed the bar's autumn link and the owner wonders why no sale is credited
to the ad:

```sh title=Terminal untested="The example needs a site that redirects, and the docs runner only runs the page check. packages/cli/src/__tests__/tags-docs.test.ts runs this command against the ad-redirects fixture and compares the output with the block below."
$ npx gaugeline tags "https://tapas-bar.example/go?utm_source=facebook&gclid=Cj0demo"
```

```text title=Output
hop 1  301  https://tapas-bar.example/go?utm_source=facebook&gclid=Cj0demo  tags: utm_source, gclid
hop 2  200  https://tapas-bar.example/landing  tags: none
Campaign tags lost at hop 1: the 301 from https://tapas-bar.example/go to https://tapas-bar.example/landing dropped utm_source, gclid.
This follows redirects only. It does not run the page's JavaScript, so a script that rewrites the address after the page loads is out of scope.
```

Exit codes are as for a page check: 0 when it ran, 1 with `--ci` when tags were lost, 2 when the link could
not be followed. A link with no tags is followed with Gaugeline's own and the first line says so. Add
`--allow-private` for an address on your own computer.

## Reading the summary

Ads that share a destination are checked once and their spend is added together, so the total tells you how much went to pages with problems.

## In the app

```sh title=Terminal untested="gaugeline open runs until Ctrl+C. packages/cli/src/__tests__/open-ads.test.ts starts it with the ads command that ships and compares the run with gaugeline ads --json."
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

::: warning Not all four checks are here yet
Campaign tags are lost is the first of the four checks in the table above. The page doesn't load, sold
out and theme placeholders arrive after it, one at a time. Until they do, the summary counts only pages
where tags are lost: a page with nothing listed has had that one check, not all four. The example above is
what the view shows once they have run, made by the same code as the app.
:::

::: info
Apps like AdStockGuard and Guardified pause ads automatically when stock hits zero. Gaugeline reports; those act. They work well together.
:::
