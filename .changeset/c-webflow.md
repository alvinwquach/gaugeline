---
"gaugeline": minor
---

Webflow: content checks for sites built on Webflow. A new adapter reads a site's CMS through the Data API with a token that has read scopes only, and two new checks find items saved but not published (`webflow-item-staged`) and published items whose page is gone (`webflow-item-no-page`).
