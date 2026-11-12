# error-pages

An invented independent bookshop (Harbour Lane Books) for the error page checks (XF-03). Nothing here is a
real business or page.

- `/`: links to three pages. `/books/tide-and-thistle` is a normal page and passes.
  `/events/readings` is a Next.js error page served with 200 (`<html id="__next_error__">`) and
  `/shop/gift-cards` is a "Page not found" page served with 200: the two findings of `error-shell-200`.
- `/gaugeline-not-found-3f9c2a71` (`routes.json`) answers 200 with the home page, as a catch-all does: the
  finding of `not-found-200`, a probing check, so `gaugeline.consent.json` gives the invented owner's
  consent to runs started from this folder.
