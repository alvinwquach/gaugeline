# house-rules-broken

An invented bakery (Wickham Lane Bakery) for `house-rules-broken` (HOUSE-01). Nothing here is a real business.

- `gaugeline.rules.json` is the house-rules file the compiler's example draft produces: headings in sentence
  case, no em dashes, never "cheap" or "bargain", buttons say "Book now", phone numbers like `000 000 0000`.
- `/` breaks all five: an `h2` in title case, an em dash, the words "cheap" and "bargain", a button that says
  "Book Now!" and a phone number written `000.000.0000`. The phone number is zeros.
- Run from a folder with no `gaugeline.rules.json`, the check asks nothing.

The passing copy is `house-rules-clean`: the same page, written to the rules.
