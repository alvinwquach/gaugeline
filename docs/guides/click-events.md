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

Two more reads come with the clicks and are not findings yet: whether each link reports the same on the phone
as on the desktop, and the order the Tab key reaches the listed links in. They are in the observation for the
checks that will judge them. `gaugeline events export`, which writes the observed events as a CSV to start a
tracking plan from, is not built.

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
