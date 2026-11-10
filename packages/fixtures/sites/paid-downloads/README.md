# paid-downloads

An invented one-person running coach (Tideline Coaching) for the paid-file checks (G26). Nothing here is a
real business, price or file. The files are linked and never requested: the addresses on `cdn.sanity.io`
are made up.

- `/`: a $48 plan linked straight to a PDF on Sanity's file CDN (`paid-file-public`), a "Terms of sale" PDF in the footer
  (`asset-file-public`: the link text says terms, so it is low even with a price), and a "Buy now" div with a click handler
  (`checkout-js-only`).
- `/plan/`: the same plan, with a Stripe payment link behind "Buy now". One high finding, no js-only finding.
- `/press/`: a brochure PDF on the CDN and no price. One low finding.
- `/class/`: a $15 beach class whose "Add to cart" is a div with a click handler. One js-only finding.
