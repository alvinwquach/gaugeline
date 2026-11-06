# nav-events

An invented coffee roastery whose rebuilt menu is meant to send `menu_click` with `link_text`,
`link_url` and `menu_parent`, for the click event checks (X25). Nothing here is a real business,
person, address or analytics property.

`gaugeline.events.json` declares every link in the nav. `observations.json` is a recorded
observation of clicking each one with analytics requests intercepted (recorded, never delivered):
what a rendered observer (G39) would report. Tests replay it with `recordedObserver`; no browser
runs and no analytics request is made.

- "Hours" under Visit has no handler and sends nothing: `events-fire`.
- "Coffee" under Visit sends exactly what "Coffee" under Shop sends (its template copies
  `menu_parent: "Shop"`): `events-distinct`.
- "Map" opens a new tab and still reports, 340 ms after the click.
- Every other link reports correctly.
