---
"gaugeline": minor
---

Published but not live: `--published` catches content the client published that never reached the site. It compares the items changed in your CMS in the last 7 days with their live pages and reports `published-not-live` (a page still shows something else after 15 minutes), `live-page-missing` (a published item whose page is a 404) and `unpublished-still-live` (a page that still serves after its item was unpublished).
