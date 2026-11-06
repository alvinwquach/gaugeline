# Printed QR codes and short links

A QR code on a table tent can't be reprinted when a restructure moves its page. Gaugeline keeps a
register of every printed address and checks each one still lands where it should, on every run.

## The register

A CSV file, any name, one row per printed address. Only `url` is required:

```csv
url,where,printedOn,expectedDestination
http://copperkettle.example/menu,table tents,2026-03-01,http://copperkettle.example/menu
http://copperkettle.example/spring-flyer,"flyers, spring 2026",2026-04-02,
```

- `where` is what a finding names ("table tents"), so it says where to look instead of an address
  nobody recognises. The same address on two flyers is requested once and reported with both.
- `expectedDestination` is the page it should land on, when you know it.
- Columns are matched loosely (`Printed URL`, `Location`, `Destination` work too), and a spreadsheet
  export's byte-order mark or quoted commas are fine.

## Checking the register

```bash
npx gaugeline printed register.csv
```

Each address is requested as printed, with GET, and its redirects are followed and read:

| Check                       | Level          | When                                                                         |
| --------------------------- | -------------- | ---------------------------------------------------------------------------- |
| `printed-dead`              | Fix this first | It ends in a 4xx or 5xx, or doesn't answer on the `http://` that was printed |
| `printed-wrong-destination` | Fix this first | It lands somewhere other than `expectedDestination`, or on an interstitial   |
| `printed-to-home`           | Fix soon       | A link to a deeper page now lands on the home page                           |
| `printed-tags-lost`         | Fix soon       | Its `utm_` parameters (or `--tags` prefixes) are gone at the destination     |
| `printed-chain`             | Worth a look   | More than two redirects                                                      |

Against the invented Copper Kettle register (`packages/fixtures/printed/register.csv`), six rows in
four places:

```text title=Output
Read 6 printed addresses from register.csv, in 4 places.
✗ A printed address doesn't land on a page
    flyers, spring 2026: http://copperkettle.example/spring-flyer ends in 404 at copperkettle.example/spring-flyer
    line 4
! A printed link to a page now lands on the home page
    events poster: http://copperkettle.example/events-2025 now lands on the home page (copperkettle.example/)
    line 5
! A printed address loses its tracking tags
    table tents: http://copperkettle.example/table-menu?utm_source=table-tent&utm_medium=qr arrives at copperkettle.example/menu without utm_source, utm_medium
    line 3

3 to look at, 1 to fix first.
```

The exit code is 1 when a printed address needs fixing, and 2 when one couldn't be reached at all
(it is listed under "could not be checked", never as passed).

- A short link that shows its own page and sends people on with a meta refresh or JavaScript is an
  interstitial: reported as the wrong destination, because a scan should redirect.
- An address printed as `http://` that the site no longer answers on, while `https://` does, is
  dead: phones open what is printed. Answer on http and redirect to https.

## Reading what was actually printed

What was printed often differs from what someone typed into a spreadsheet. `--decode` reads the QR
code in each PNG image (or every PNG in a folder) on this computer, with no network call, and adds
the addresses the register doesn't have yet, with the image's name as `where`:

```bash
npx gaugeline printed register.csv --decode ./flyers/*.png
```

Existing rows are never rewritten. An image whose code can't be read (blurred, too small, not
there) is listed as could not be checked. PNG images only, 8-bit or palette, not interlaced.

## Before a restructure

`gaugeline plan` takes the register too. With `--base`, each printed address that isn't a planned
page joins the 301 map as an old address, on the row of its `expectedDestination`, so the plan is
checked against what was printed before launch:

```bash
npx gaugeline plan sitemap.csv --base https://preview.yoursite.com --printed register.csv
```

A printed address whose expected page isn't in the plan is counted on stderr: give it an
`expectedDestination` that is.
