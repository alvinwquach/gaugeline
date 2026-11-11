---
"gaugeline": minor
---

Sanity images: three new checks read the cdn.sanity.io addresses on a page. They find images served at the size they were uploaded (`sanity-image-original`), images delivered far larger than the width they are shown at (`sanity-image-oversized`), and one uploaded image processed more than once on a page (`sanity-image-duplicate`). They read the page's own HTML and need no Sanity key.
