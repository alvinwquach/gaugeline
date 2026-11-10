---
"gaugeline": minor
---

`gaugeline delivery --paid --sent` compares paid orders in Stripe with the emails Resend says it sent, and `gaugeline platform --webhooks` reads webhook delivery history; both are read only and print counts, never customer data.
