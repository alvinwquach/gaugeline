# tag-rules

An invented second-hand bookshop with a Tag Manager container export that has outlived its site,
for the tag rule checks (X34). Nothing here is a real business, person, address or container.

`gaugeline.tags.json` points at `../../gtm/harbour-books.json` (container `GTM-TEST01`, invented).

- "PDF downloads (old)" waits for a link whose address contains `/wp-content/uploads/`; the only
  download is `/files/catalogue.pdf`: `tags-dead-rules`.
- "Contact form sent" waits for the form id `contact-form`; the form is now `contact-form-2024`:
  `tags-dead-rules`.
- "Newsletter" is fired by two GA4 tags sending `generate_lead` to the same measurement ID:
  `tags-duplicate`.
- "Catalogue clicks (regex)" matches `\.pdf$` and can fire; "Readings pages" and All Pages can fire.
- "Members renew" fires only on `/members/*`: `/members/renew` is in the sitemap but no page the
  run reads links to it, so it is never read: could not check. "Scroll depth" is a trigger type the check doesn't read: could
  not check.
