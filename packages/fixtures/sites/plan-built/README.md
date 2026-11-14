# plan-built

An invented pottery shop's preview build and its 10-row launch plan (`plan.csv`), for the plan check
against a built site (G17, `--base`). Nothing here is a real business. The plan names production
addresses on `harbour-pottery.example`; the fixture server stands in for the preview.

Five planted errors, one each:

- `/shop`: the title is "Shop – Harbour Pottery", the plan says "Shop | Harbour" (plan-title-drift).
- `/about`: the H1 is "Our story", the plan says "About us" (plan-h1-drift).
- `/contact`: the canonical still names the legacy `/contact-us` (plan-canonical-elsewhere).
- `/gallery`: not built, 404 (plan-404).
- `/faq#returns`: the FAQ page has no `returns` section (plan-anchor-missing).

And what must pass: three rows on `/classes` (the page and two sections that exist) are one
request; `/kiln` is planned on `www.` with a curly apostrophe and the page uses a straight one.
