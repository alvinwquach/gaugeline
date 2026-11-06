# printed-links

An invented tavern, The Copper Kettle (`copperkettle.example`), whose QR codes and flyers are listed
in `packages/fixtures/printed/register.csv`, for the printed links check (N08). Nothing here is a
real business.

- `/menu`, `/reservations`, `/events` and `/` are pages.
- `/table-menu` 301s to `/menu` and drops its query string (the utm_ tags are lost).
- `/events-2025` 301s to the home page (the lazy redirect after a restructure).
- `/book` 301s to `/reservations` (right).
- `/spring-flyer` is 404 (dead).
