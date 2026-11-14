---
"gaugeline": minor
---

New check `nav-link-not-200`: it reads the whole trail of every menu link and finds the ones that take two or more redirects (with the hop count), loop, or end on something that is not a 200.
