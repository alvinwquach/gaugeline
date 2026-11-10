# ad-redirects

An invented tapas bar's ad links, for the campaign tag survival checks (`gaugeline tags`, and the
ads command's `campaign-fields-lost`). Each route answers by itself; none reads the query string.

- `/go`: 301 to `/landing` with no query. Every campaign tag is lost at hop 1.
- `/go-keeps`: 302 to `/landing` keeping `utm_source`, `utm_medium` and `utm_campaign` (with the
  values `facebook`, `paid` and `autumn-menu`) and dropping `gclid`.
- `/go-fragment`: 302 to `/landing#utm_source=facebook`: the tag moved into the fragment.
- `/chain` then `/chain-2`: the first redirect keeps `utm_source` and `utm_medium`, the second drops them.
- `/loop-a` and `/loop-b` send people to each other, keeping `utm_source`.
- `/landing`, `/`: a page that answers 200. `/gone` answers 404.
