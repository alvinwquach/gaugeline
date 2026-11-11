---
"gaugeline": minor
---

Contentful: content checks for sites built on Contentful. A new adapter reads a space through the Content Delivery API with a delivery token (read-only), and a new check (`contentful-entry-no-page`) finds published entries whose page is gone. The key-in-JavaScript check (`secret-in-js`) now also recognises a Contentful preview token (reported by kind and place, with no character of the token) and no longer reports a Contentful delivery token, which is public by design.
