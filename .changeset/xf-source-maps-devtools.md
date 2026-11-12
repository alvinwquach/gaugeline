---
"gaugeline": minor
---

Two new checks for any site: `source-maps-public` finds a script or stylesheet that names a source map anyone can fetch (reporting file paths and counts, never what is in the map), and `dev-tools-in-production` finds a Vite, webpack, Next.js or React development marker, or an address on the developer's own machine, in the live page or its scripts.
