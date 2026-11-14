# Click events: the tracking plan, checked

A before-and-after comparison of a new menu is only real if every link reports where it sits.
Tracking breaks quietly when templates change, and nobody learns until the report is empty.
Gaugeline reads your tracking plan, clicks each element it names, and checks what was pushed to
`dataLayer`.

::: warning Off unless you ask
Clicking needs a browser, so it happens only with `--renderer playwright` (a browser you installed:
[Rendered pages](../rendered-pages.md)). Without it the plan is read and its elements are found, but nothing is
clicked: the click checks are listed under could not check, with the reason. Nothing is ever reported as passed
without being clicked.
:::

## Writing the plan

Put `gaugeline.events.json` in the folder you run Gaugeline from (it moves into the config file when
that arrives). Each line names the elements, by a CSS selector or as every link in a region (`nav`,
`header`, `footer` or `main`), the event a click must push, and the parameters it must carry:

```json
{
  "events": [
    { "region": "nav", "event": "menu_click", "params": ["link_text", "link_url", "menu_parent"] },
    { "selector": "a.book", "event": "book_click", "params": ["link_text"] }
  ],
  "consent": { "accept": "Accept all" }
}
```

A line with both a selector and a region, or neither, stops the run (exit 2) naming it. `consent`
is optional: it is the exact text of a **link** that accepts the consent banner. Gaugeline clicks links only,
never a button, so a banner whose accept control is a button leaves the click checks could not check, with the
reason.

## What happens on each click

- At most 20 elements are listed per run, in the plan's order. **Only links are clicked**: an element with an
  address that is a web address, visible, and not inside a form. A button, an input, a link in a form and a link
  whose address is not http or https are never clicked; they are reported as not observed, with the reason, and
  that is could not check, never a pass. A link to another site is clicked only when the plan names it by a
  selector (a region such as `nav` is not a list of other sites to visit), and then the browser does not go
  there: the page's own handlers run and the move is cancelled. A click that would take the page to another site
  any other way, such as a link on this site that redirects there, is refused: the other site is never asked.
  What is clicked is checked again in the page as the click lands: if a script changed the link's address to
  something that is not a web address, or swapped the link for a button, the click is stopped.
  Nothing a click makes is submitted: a frame a click builds loads nothing, and the browser is asked which
  navigations are a form's, in any frame, and none is requested. A page that never returns after it loads is
  given up on, and its browser tab is closed.
- **Every click starts from a fresh page.** Each click gets a new browser context that loads the page again, so
  no cookie, storage or cache from an earlier click is there. Each element is clicked once at a desktop width
  (1280 px) and once at a phone width (375 px). A link that is not visible at a width is not observed there.
- **The plan's author is responsible for what it lists.** A link on your own site that the plan lists is
  clicked, whatever it is called: `/logout` or `/account/delete?confirm=1` is a `GET` with no credentials, in a
  fresh context, so it does nothing to a signed-in visitor, but a plain link that changes something on a `GET`
  would. List only links that are safe to visit.
- Every analytics request a click starts is intercepted and recorded, never delivered. What it would have sent
  (the event name and its parameters, read from the request; never an identifier) counts as the click's event,
  beside the pushes to `dataLayer` (including `gtag('event', ...)`). The analytics libraries themselves are not
  loaded, so an event only a tag manager would send is not seen: the page's own pushes and requests are. A link
  that opens a new tab is clicked without leaving the page.
- Pushes to `dataLayer` are read for 1500 ms after each click. A push after that is reported as late.
- A parameter counts as filled when it is a non-empty string, a number or a boolean.

## The checks

- `events-fire`: the element sent no event with the plan's name, sent it twice, or sent it without
  a parameter the plan requires. The evidence is the event as sent.
- `events-distinct`: two links to the same page under different parent menus send identical values,
  so the report can't tell them apart.

- `events-parity`: a link that reports on a desktop and not on a phone, or under another name, or with a
  parameter empty on one of them. See [On a phone, and with the keyboard](#on-a-phone-and-with-the-keyboard).
- `events-tab-order`: a link the Tab key never reaches, a link that takes focus in another place than it comes in
  the page, or a link with a positive `tabindex`. Same section.

`gaugeline events export`, which writes the observed events as a CSV to start a tracking plan from, is not built.

## On a phone, and with the keyboard

A menu rebuilt for phones is often a second template, and a second template loses the handler. Gaugeline reads
each listed link twice, at 1280 px and at 375 px, in the same observation, and compares the two as plain rules.
It also presses the Tab key and reads the order in which the listed links take focus. Neither needs a flag beyond
`--renderer playwright`, and neither types anything or clicks anything the plan did not list.

`events-parity` names the link, both widths and what differs, one finding a link:

- the event was sent at one width and not the other (or only after the 1500 ms the check waits);
- it was sent under another name at one width (`menu_tap` for `menu_click`);
- it was sent twice at one width and once at the other;
- a parameter the plan lists is filled at one width and empty at the other, or is a different kind of value
  (text at one, a number at the other);
- a parameter the plan does not list is sent at one width only.

Values are compared by kind (text, a number, true or false, empty) and never by exact text, because a parameter such
as a device name differs between a phone and a desktop on purpose. A link silent at both widths is `events-fire`'s.
A link that could not be clicked at one width (a menu that is hidden under 600 px, say) is **could not check** with
the width and the reason, never a difference and never a pass; so is a page that would not load at 375 px.

`events-tab-order` reads three things about the links the plan lists, one finding for each kind that is found:

- **never reached**: the Tab key, pressed from the top of the page at 1280 px (at most 200 times, nothing else
  typed), never put focus on the link. A link with `tabindex="-1"` says so in the finding;
- **out of order**: the link took focus in a different place than it comes in the page's HTML. Only the links that
  moved are named, not every link they moved past. The page's order stands for the visual order: a layout that moves
  a link on the screen is not read, and the plan has no order of its own;
- **positive tabindex**: a listed link carries `tabindex` of 1 or more, which puts it ahead of every link without
  one. This is read from the HTML as sent, so it is found without a browser; a `tabindex` a script adds later is not
  seen there, though a link that moves for it shows as out of order.

A link that could not be clicked at 1280 px, or a keyboard that never left the page in 200 presses, is could not
check. At most three links are named in a finding, then the rest are counted, and every word the site chose is
cleaned and cut.

For a florist whose rebuilt menu gives Weddings a `tabindex="2"` and Contact a `tabindex="-1"`, with no browser, the
positive `tabindex` is found and the rest says it could not be checked:

<!-- fixture: nav-tab-order -->

```sh title=Terminal
$ npx gaugeline larkspur.example
```

```text title=Output
· A tracked link is hard to reach with the keyboard
    1 of the plan's links has a positive tabindex, which puts it ahead of every link without one: "Weddings" (/weddings) has tabindex="2"
? events-distinct could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? events-fire could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? events-parity could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? events-tab-order could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? events-unlisted could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

1 to look at, none to fix first.
```

With a recorded observation of that site (`observations.json`: what the browser would report at both widths and
for the Tab key), the checks find:

```text
"Weddings" (/weddings) reports differently at 375 px than at 1280 px: sent menu_click at 1280 px but menu_tap at 375 px
"Delivery" (/delivery) reports differently at 375 px than at 1280 px: sent menu_click at 1280 px and nothing at 375 px
"Contact" (/contact) reports differently at 375 px than at 1280 px: link_text is filled at 1280 px and empty at 375 px
1 of the plan's links is never reached by the Tab key: "Contact" (/contact, tabindex="-1")
1 of the plan's links takes focus in a different place than it comes in the page: "Weddings" (/weddings) is reached 1st but comes 2nd
1 of the plan's links has a positive tabindex, which puts it ahead of every link without one: "Weddings" (/weddings) has tabindex="2"
```

The invented fixture is `packages/fixtures/sites/nav-tab-order`. The first output is asserted by
`packages/cli/src/__tests__/nav-tab-order.test.ts` and checked by `pnpm docs:examples`; the replay is asserted by
`packages/core/src/checks/__tests__/events-parity.test.ts` and `events-tab-order.test.ts`, and the same findings from
a real browser by `packages/renderer/src/__tests__/observer.e2e.test.ts`.

## Attributes every link must carry

Clicks need a rendered read, but whether a link carries the attribute your tag reads does not: it is in the HTML
the site sends. Under `attributes` in the same `gaugeline.events.json`, name the elements (a CSS selector, or every
link in a region) and the attributes each must have, with a value:

```json
{
  "attributes": [
    { "region": "nav", "require": ["data-track"] },
    { "selector": "a.book-now", "require": ["data-track", "data-location"] }
  ]
}
```

A plan may hold only `attributes`, only `events`, or both. A line with both a selector and a region, or neither,
stops the run (exit 2), and so does an attribute name with a space or a quote in it.

- `tracking-attributes-missing` reports one finding per line: how many of the elements it selected lack an
  attribute, which attribute, and the first three links by their text and address.
- An attribute with no value (`data-track=""`) or only spaces is missing: a tag that reads it gets nothing.
- Regions are read as the click plan reads them: a link inside a `nav` is `nav` even when the `nav` sits in a
  `header`; `javascript:` links are left out.
- Nothing is requested or clicked: the check reads the page the run already fetched.

For a bicycle repair shop that tags its menu links for a before-and-after comparison, with Hire and Contact left
untagged and one of its two "Book" buttons missing the location:

<!-- fixture: nav-attributes -->

```sh title=Terminal
$ npx gaugeline spokeandchain.example
```

```text title=Output
! Some links are missing an attribute your tracking plan requires
    nav links: 2 of 4 have no data-track: "Hire" (/hire), "Contact" (/contact)
! Some links are missing an attribute your tracking plan requires
    a.book-now: 1 of 2 have no data-location: "Book a hire bike" (/hire)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 4 of 5 other pages.
2 to look at, none to fix first.
```

The invented fixture is `packages/fixtures/sites/nav-attributes`. The output is asserted by
`packages/cli/src/__tests__/nav-attributes.test.ts` and checked by `pnpm docs:examples`.

## The plan as a spreadsheet

A tracking spec usually starts as a sheet. Export it as CSV, name it `gaugeline.events.csv` and put it in the
folder you run Gaugeline from instead of `gaugeline.events.json` (both in one folder stops the run, exit 2). It is
read the way the [launch plan](/docs/plan-check) is read: RFC 4180 quoting, headers matched loosely (case and
punctuation do not matter), a byte-order mark and blank rows ignored, and one plan line per row.

| Column (any of these names)                   | What it holds                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `Region`                                      | `nav`, `header`, `footer` or `main`: every link in it                            |
| `Selector`, `CSS selector`                    | A CSS selector for the elements                                                  |
| `Element`, `Elements`, `Target`               | Either: a region name is a region, anything else is a selector                   |
| `Event`, `Event name`                         | The event a click must push                                                      |
| `Parameters`, `Params`, `Required parameters` | Names that must be filled, separated by commas, semicolons or line breaks        |
| `Attributes`, `Required attributes`           | Attributes the elements must carry (see above); a row may have this and an event |

```text
Region,Selector,Event,Parameters,Attributes
nav,,menu_click,"link_text, link_url, menu_parent",data-track
,button.book,book_click,button_text,
```

A row names exactly one of a region or a selector, and needs an event, attributes or both. A row that cannot be read
stops the run (exit 2) with the file name and the line, for example
`gaugeline.events.csv line 3: the region "sidebar" is not one of nav, header, footer, main`. A cell is text: a formula
or markup in one is never run.

## Events nobody planned

`events-unlisted` is the other half of the spec. The spec's events that never fire are `events-fire` (an element that
sent nothing). `events-unlisted` lists the events a click sent that no line of the plan names, with the element and
what it sent; the tag manager's own `gtm.*` events and pushes with no event name are left out, and the same event on
several links is one finding. It reads the same clicks as `events-fire`, so it needs the same rendered read: until
then it is could not check, and nothing is reported as passed.

For the coffee roastery with its plan in a spreadsheet:

<!-- fixture: nav-events-csv -->

```sh title=Terminal
$ npx gaugeline roastery.example
```

```text title=Output
? events-distinct could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? events-fire could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? events-parity could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? events-tab-order could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? events-unlisted could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 4 of 5 other pages.
Nothing to look at.
```

The output is asserted by `packages/cli/src/__tests__/events-csv.test.ts` and checked by `pnpm docs:examples`; the
recorded replay of `events-unlisted` is in `packages/core/src/checks/__tests__/events-unlisted.test.ts`.

## Example

Against the invented `nav-events` fixture, a coffee roastery whose rebuilt menu declares every nav
link, version 0.1.0 prints:

```text title=Output
? events-distinct could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? events-fire could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? events-parity could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? events-tab-order could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? events-unlisted could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 4 of 5 other pages.
Nothing to look at.
```

Replaying the fixture's recorded observation (`observations.json`, what a rendered read would
report) finds the two problems the fixture was built with:

```text
"Hours" (/hours) sent no menu_click event
/coffee under "Shop" and under "Visit" both send {"event":"menu_click","link_text":"Coffee","link_url":"/coffee","menu_parent":"Shop"}
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/click-events.test.ts`, and the replay by
`packages/core/src/checks/__tests__/click-events.test.ts`.
