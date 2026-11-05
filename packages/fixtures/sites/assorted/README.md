# assorted

An invented fabric shop on `assorted.test` that trips the checks no single-purpose fixture reaches,
so a run of the built CLI over every fixture shows every check firing:

- sitemap-host: the sitemap lists only `staging.assorted.test` (served by the same files).
- feed-invalid: `/feed` is an HTML page. feed-oversized: `/archive.xml` is 2.2 MB.
- quotable-facts-disagree: the structured data says "Bobbin & Bolt", llms.txt says "Spindle Supply Co".
- images-alt-empty: both images have `alt=""`. images-heavy and page-heavy: each is 1.7 MB.
- html-heavy: an inline `__NEXT_DATA__` block is most of the HTML.
- tel-format: `tel:(503) 555 0100`. The number is in the fictional 555-01xx range.
- jsonld-invalid (one broken block), jsonld-404 (`/products/linen-thread` does not exist),
  structured-duplicate (Product in JSON-LD and as microdata).
- og-url-mismatch (og:url is `/home`, the canonical is `/`), og-image-relative.
- ics-no-vtimezone: `/classes.ics` uses TZID America/Los_Angeles with no VTIMEZONE.
- event-location-mismatch: the Sewing circle is "at" Bobbin & Bolt but lists 41 Weft Street; the shop is at 7 Spindle Row.
- duplicate-title (a second title in the head), nav-home-links ("Services" goes to /), nav-label-drift (/classes is "Sewing classes" and "Classes"), links-vague-text ("Read more"), links-wrapped (bit.ly), mock-content-live (the 555 number).
- stega-leak: the title ends with invisible Unicode tag characters, written by a script.
