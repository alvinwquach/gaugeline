# Documents agree with the site: PDF menus, price lists and brochures

A bar, a pop-up or a clinic usually keeps a printable PDF linked from the site: the menu, the price list,
the rates. Nobody updates it when the page changes. The page says the burger is $16, the PDF says $14, and
the customer screenshots the PDF.

These checks read the PDFs your pages link to and compare them with what the site says.

| Check                     | Finds                                                                                     | Severity       |
| ------------------------- | ----------------------------------------------------------------------------------------- | -------------- |
| `document-price-mismatch` | An item whose price in the PDF is not its price on the site (both values shown)           | Fix this first |
| `document-item-missing`   | An item on the site and not in the PDF, or in the PDF and nowhere on the site             | Fix soon       |
| `document-hours-mismatch` | Opening hours in the PDF that differ from the site's hours or a listing's                 | Fix this first |
| `document-unreadable`     | A PDF with no text to read (a scan, an encrypted file), so nothing in it could be checked | Worth knowing  |

They only look. Each PDF is fetched with a `GET` (after a `HEAD` for its size, type and date), the way a
visitor's browser would, and nothing is sent anywhere.

## Install the reader

Reading a PDF needs an extractor. The published `gaugeline` package keeps no runtime dependencies, so the
extractor is a separate, optional package with no dependencies of its own. Install it in the project where you
run Gaugeline:

```sh
npm install --save-dev @gaugeline/documents
```

Without it these checks say they could not check, with the line `install @gaugeline/documents to read PDFs`,
never that the PDF is fine.

## What it compares with

For each item it reads in the PDF (a line such as `Smash Burger ........ 16`, `Smash Burger $16.00` or
`Lumpia (6) 9 / (12) 16`) it asks, in this order, and the first source that names the item decides:

1. The content system and the payment system, when the run was given their prices (a Sanity price, then the
   default price of the matched Stripe product).
2. The prices you declared in [`gaugeline.facts.json`](../guides/facts.md).
3. The words of the pages Gaugeline read: the item's name, and the first price written after it.

Names are matched with the same rule the product matcher uses: case, punctuation and `&` versus `and` do not
matter. An item that appears twice in the PDF with two different prices is not compared. A line that does not
parse as an item and a price (an address, a phone number, hours) is left out, never guessed.

"In the PDF but not on the site" is said only when the two are shown to be the same menu: a source names one
of the PDF's items, or the pages carry at least half of them. A page that lists three dishes does not make the
other forty dishes in the PDF "missing".

Hours are read with the parser the listing checks use, so `Fri-Sat 4pm-2am` is Friday and Saturday from 4pm
until 2am. Only the days the PDF states are compared, against the hours in `gaugeline.facts.json` or the page's
`openingHours`, and against each [listing](../connectors/listings.md) that has hours.

## A pop-up's printable menu

Marigold Taco Pop-Up is an invented taco pop-up. The page lists this season's menu; the PDF linked as
"Printable menu" is last season's, and its footer still says the stall closes at 10pm. Version 0.1.0 prints:

<!-- fixture: printed-menu -->

```sh title=Terminal
$ npx gaugeline shop.example
```

```text title=Output
✗ A PDF shows different opening hours than the site or a listing
    Friday: the document says 5pm-10pm, your site says 5pm-11pm; Saturday: the document says 5pm-10pm, your site says 5pm-11pm (site hours from the page's structured data) (document https://shop.example/menu.pdf)
✗ A PDF menu or price list shows a different price than the site
    In https://shop.example/menu.pdf, 2 prices differ from the site: Carne Asada Taco: the document says $3.50, the page / says $4.00; Horchata: the document says $4.00, the page / says $5.00
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 to look at, 2 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`pnpm docs:examples` in CI. To fix it, re-export the PDF from this season's menu and replace the file, or
take the link down until you can. Gaugeline shows the address the file was read from after any redirect, and
the file's `Last-Modified` date when the server sends one, so you can see how old the PDF is.

## What it never does

- It never guesses. A scanned PDF (a picture of a page) has no text layer: it is reported by
  `document-unreadable` and nothing in it is compared. There is no OCR, because guessing a price from an image
  would make false findings.
- An encrypted PDF, a file cut off by the download, a file that is not a PDF and a file over the size limit
  are each reported as could-not-check with the reason, never as a pass.
- It does not send anything. A PDF is read in memory and dropped; its text is not kept or logged, and findings
  show item names, prices and days, not the rest of the document.

## Limits

| Limit                           | Value                                                       |
| ------------------------------- | ----------------------------------------------------------- |
| Documents read per run          | 5 (the rest are named, not read)                            |
| File size                       | 10 MB; larger files are skipped with the size and the limit |
| Pages read                      | 200                                                         |
| One compressed stream, inflated | 4 MiB; more is refused (a decompression bomb)               |
| All streams, inflated           | 48 MiB                                                      |

## Choose the documents: `gaugeline.documents.json`

By default Gaugeline reads the PDFs the pages it read link to, and links whose text or `rel` says menu, price
list, brochure or rates (a link that turns out to lead to an HTML page is dropped). To add some, leave some
out or change the size limit, put this next to your other `gaugeline.*.json` files:

```json
{
  "documents": {
    "include": ["https://files.example/marigold/winter-menu.pdf", "/downloads/catering-rates.pdf"],
    "exclude": ["/press/"],
    "maxMegabytes": 15
  }
}
```

`include` takes absolute addresses or paths on the site; `exclude` leaves out any address that contains the
text; `maxMegabytes` is at most 25.

## The checks, one by one

Each has an entry in the [checks reference](../checks.md): what it catches, why it matters and how to fix it.
