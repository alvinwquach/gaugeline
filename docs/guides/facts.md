# Facts that must match everywhere

A small business has a handful of facts that cost money when they disagree: opening hours, a phone
number, a payment handle, a price. Each appears on several pages and in the structured data search
engines read. Declare them once, and Gaugeline checks every place they appear.

## Declaring facts

Put `gaugeline.facts.json` in the folder you run Gaugeline from (it moves into the config file when
that arrives):

```json
{
  "facts": [
    { "id": "phone", "kind": "phone", "value": "(503) 555-0142" },
    { "id": "hours", "kind": "hours", "value": "Fri 5pm-9pm; Sat 5pm-9pm" },
    { "id": "venmo", "kind": "handle", "service": "venmo", "value": "@marigold-tamales" },
    {
      "id": "tamal-box",
      "kind": "price",
      "item": "Tamal box",
      "value": "$12",
      "variants": [{ "name": "Tamal box (half)", "value": "$7" }]
    },
    {
      "id": "pickup",
      "kind": "text",
      "value": "Pick up at the side window",
      "mustAppearOn": ["/order"]
    }
  ]
}
```

`kind` is `phone`, `hours`, `handle` (with `service`: `cashapp`, `venmo` or `zelle`), `price` (with
the `item` it is for, and `variants` for other sizes) or `text`. `selector` limits where a fact is
read from to one part of the page. `mustAppearOn` lists pages the fact has to be on.

## How facts are compared

Comparison is conservative: `$5` equals `$5.00`, `5pm` equals `5:00 PM`, a handle is the same in any
letter case, and phone numbers compare by their digits. Nothing looser. A value that can't be read
(`5ish-late`) is unchecked, never guessed.

Facts are read from the visible text (by pattern, or inside the selector), from links (`tel:`,
`venmo.com/...`, `cash.app/$...`) and from structured data, on the checked page and the first 4
pages it links to. A fact written only in an image's description doesn't count as being on the
page: visitors can't read it.

Cash App and Venmo profile links are requested to make sure they answer (at most 5 per run). Only
the address the page links to is sent.

## Example

Against the invented `popup` fixture, a tamal pop-up whose menu page mistypes its Venmo handle and
whose structured data still has last season's hours, version 0.1.0 prints:

```text title=Output
✗ A fact about your business differs between pages
    hours: declared "Fri 5pm-9pm; Sat 5pm-9pm", as on /; / has "{"fri":"17:00-20:00","sat":"17:00-21:00"}" (structured data)
✗ A fact about your business differs between pages
    venmo: declared "@marigold-tamales", as on /; /menu has "@Marigold-Tamale" (text)
✗ Test content is on the live site
    1 test item in the main content: "(503) 555-0142"
! A page is missing a fact it should show
    pickup ("Pick up at the side window") is not on /order: it is only in an image description

Checked all 2 links, all 3 sitemap pages, all 2 other pages, 1 payment link.
4 to look at, 3 to fix first.
```

The fixture's phone number is in the 555 range reserved for fiction, which is exactly what
`mock-content-live` looks for. Each check that passed also prints a `✓ <id>` line, left out above.
The output is asserted by `packages/cli/src/__tests__/facts.test.ts`, with the Venmo profile
answered locally rather than by venmo.com.
