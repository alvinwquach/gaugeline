---
"gaugeline": minor
---

Angular SSR and Analog sites: five new checks. They find dev tools served in production (`angular-dev-tools-public`), a preview deployment used as the canonical address (`angular-preview-canonical`), private-looking fields in the page's transfer state (`angular-state-private-fields`), an Angular error served with a 200 (`angular-ssr-error-200`), and the Analog server functions and page endpoints a page names (`angular-analog-endpoints-listed`). All read the page's own HTML; nothing is requested or called.
