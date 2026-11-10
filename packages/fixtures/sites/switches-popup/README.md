# switches-popup

An invented tamal pop-up for N11 (switches, sold out and capacity). Pre-orders are switched off and
the 100-dish cap for tonight is used up, but the site did not follow:

- The header on every page still links to `/order` (the pre-orders switch is off).
- `/order` still says "Pre-orders are open" and does not say "order at the window" (switch-page-wrong).
- `/order` has an order form and does not say "sold out" although nothing is left.
- `/menu` still lists "Tamal de rajas" (the 86 list says "Tamales de rajas", with the plural) and its
  Menu structured data still has "Pozole rojo", which the page itself no longer shows.

The pages are plain files with relative links; the canonical, sitemap and share-image addresses name `marigold.example`, which tests map to the files with an in-memory site. The two
configuration files are what a freelancer would write for the site; the answers they read are
supplied by the tests (a recorded Sanity answer and a stand-in Postgres), never by a real service.
