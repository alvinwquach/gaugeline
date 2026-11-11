---
"gaugeline": minor
---

Astro sites: five new checks for sites built with Astro. They find dev tools served in production (`astro-dev-tools-public`), a preview deployment used as the canonical address (`astro-preview-canonical`), private-looking fields in an island's props (`astro-private-props`), a draft entry embedded in a live page (`astro-draft-entry-public`), and the Actions and server islands a page calls (`astro-endpoints-listed`). All read the page's own HTML; nothing is posted to an action.
