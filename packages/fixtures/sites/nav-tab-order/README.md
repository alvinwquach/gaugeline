# nav-tab-order

An invented florist (Larkspur Flowers) whose rebuilt menu is meant to send `menu_click` with `link_text` and
`link_url` on a phone as on a desktop, and to be reached with the Tab key in the order it is written, for the phone
and keyboard checks (NAV-09). Nothing here is a real business, person, address or analytics property.

`gaugeline.events.json` declares every link in the nav. `observations.json` is a recorded observation of
clicking each one at 1280 px and at 375 px, and of the Tab key (what a rendered observer reports). Tests replay it
with `recordedObserver`; no browser runs and no analytics request is made.

- "Weddings" has `tabindex="2"`, so the keyboard reaches it before every link without one:
  `events-tab-order` reads that from the page as sent, with no browser. On the phone it sends `menu_tap`, not
  `menu_click`: `events-parity`.
- "Delivery" reports on a desktop and sends nothing on a phone: `events-parity`.
- "Contact" sends `link_text` on a desktop and an empty one on a phone: `events-parity`. It has `tabindex="-1"` and
  the keyboard never reaches it: `events-tab-order`.
- "Bouquets" reports the same on both and is the first link in the page, and the keyboard reaches it second
  (after "Weddings").
