# nav-after

The Rye and Ember bakery after its menu restructure (X24), on the same host as `nav-before`.

- Catering moved under Menu (moved).
- About is now called Our story (renamed).
- Gift cards is gone from the menu, and no page links to `/gift-cards` any more: the one page left
  with no inbound link (removed, fix first; and an orphan in the sitemap).
- A separate mobile menu has every desktop link except Visit (nav-parity).
- The Breads page's footer has no Terms link (nav-footer: a footer that differs on one template).

`gaugeline.nav.json` requires Privacy and Terms in the footer, and switches on the checks that read
the run's other pages (nav-orphans, nav-footer) without `--since last`.
