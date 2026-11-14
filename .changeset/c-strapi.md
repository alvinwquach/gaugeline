---
"gaugeline": minor
---

Strapi: content checks for sites built on Strapi. A new adapter reads a Strapi backend through its REST API with a Read-only API token, and two new checks find published entries whose page is gone (`strapi-entry-no-page`) and, only with `--owner-consent`, unpublished entries that a visitor with no token can list (`strapi-drafts-public`).
