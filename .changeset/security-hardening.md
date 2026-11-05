---
"gaugeline": minor
---

Gaugeline now refuses to request loopback, private, link-local (including 169.254.169.254) and other non-public addresses, on the first request and on every redirect, and connects only to the address it checked. Pass --allow-private to check a site on your own computer or network.
