# nav-utm

An invented neighbourhood bar (The Lantern Bar) for `nav-utm-lost` (NAV-01). Nothing here is a real business.

- `/menu`, `/about`, `/privacy`: answer 200 with no redirect: the tags arrive.
- `/whats-on` (`routes.json`): a 301 to `/events` with no query string: it drops the three test tags (the finding).
- `/private-hire`: a 301 to `/hire` whose address carries the three test tags: they arrive.
