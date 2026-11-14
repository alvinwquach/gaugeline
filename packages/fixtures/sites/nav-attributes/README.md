# nav-attributes

An invented bicycle repair shop (Spoke and Chain) for `tracking-attributes-missing` (NAV-05). Nothing here is a real business.

- `gaugeline.events.json` has two attribute rules and no events: every nav link needs `data-track`, and every `a.book-now` needs `data-track` and `data-location`.
- The nav has four links: Repairs and Bikes have `data-track`, Hire has none, Contact has an empty one: two findings' worth of links.
- The two `a.book-now` buttons: the first has both attributes, the second lacks `data-location`.
