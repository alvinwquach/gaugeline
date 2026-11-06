# Click events: the tracking plan, checked

A before-and-after comparison of a new menu is only real if every link reports where it sits.
Tracking breaks quietly when templates change, and nobody learns until the report is empty.
Gaugeline reads your tracking plan, clicks each element it names, and checks what was pushed to
`dataLayer`.

::: warning Not switched on yet
Clicking needs a rendered read of the page, and rendered reads are an open decision (G39). Until
then the plan is read and its elements are found, but nothing is clicked: both checks are listed
under could not check, with the reason. Nothing is ever reported as passed without being clicked.
:::

## Writing the plan

Put `gaugeline.events.json` in the folder you run Gaugeline from (it moves into the config file when
that arrives). Each line names the elements, by a CSS selector or as every link in a region (`nav`,
`header`, `footer` or `main`), the event a click must push, and the parameters it must carry:

```json
{
  "events": [
    { "region": "nav", "event": "menu_click", "params": ["link_text", "link_url", "menu_parent"] },
    { "selector": "button.book", "event": "book_click", "params": ["button_text"] }
  ],
  "consent": { "accept": "#accept-all" }
}
```

A line with both a selector and a region, or neither, stops the run (exit 2) naming it. `consent`
is optional: it says which button accepts the consent banner. Without it, a banner that blocks
analytics makes both checks could not check, with the reason.

## What happens on each click

- At most 20 elements are clicked per run, in the plan's order.
- Every analytics request a click starts is intercepted and recorded, never delivered, so checking
  never pollutes your real reports. A link that opens a new tab is clicked without leaving the page.
- Pushes to `dataLayer` are read for 1500 ms after each click. A push after that is reported as late.
- A parameter counts as filled when it is a non-empty string, a number or a boolean.

## The checks

- `events-fire`: the element sent no event with the plan's name, sent it twice, or sent it without
  a parameter the plan requires. The evidence is the event as sent.
- `events-distinct`: two links to the same page under different parent menus send identical values,
  so the report can't tell them apart.

`gaugeline events export`, which writes the observed events as a CSV to start a tracking plan from,
arrives with the rendered read.

## Example

Against the invented `nav-events` fixture, a coffee roastery whose rebuilt menu declares every nav
link, version 0.1.0 prints:

```text title=Output
? events-distinct could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? events-fire could not be checked: clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39) (/)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

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
