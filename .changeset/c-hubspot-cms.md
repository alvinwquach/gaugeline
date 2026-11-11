---
"gaugeline": minor
---

HubSpot CMS: content checks for sites built on HubSpot CMS. A new adapter reads a HubSpot portal through its CMS Pages, Blog Posts and HubDB APIs with a private app token, and three new checks find a page published in HubSpot that answers 404 on the live domain (`hubspot-page-404`), a HubDB row that differs from the page showing it (`hubspot-hubdb-drift`), and a page that embeds a deleted HubSpot form (`hubspot-form-deleted`).
