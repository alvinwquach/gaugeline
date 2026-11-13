# nav-chain

An invented veterinary practice (Marlow Vets) for `nav-link-not-200` (NAV-02). Nothing here is a real business.

- `/pricing` (also in the footer): answers 200 at once: fine.
- `/services`: 301 to `/our-services`, then 302 to `/care`: a chain of two redirects.
- `/vaccinations`: 302 to `/vaccinations-2`, which 302s back: a loop.
- `/newsletter`: answers 204: not a page.
- `/old-rooms`: nothing there, so 404: `broken-links` reports it (the link sample asked it), and `nav-link-not-200` leaves it to that check.
