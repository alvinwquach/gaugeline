---
notReleased: true
---

# Automatic messages

Checks for the webhooks Sanity sends when you publish.

- Filters that can never fire, because Sanity silently treats subqueries and cross-dataset references as false.
- Endpoints that accept unsigned requests, so anyone could trigger them.
- Deliveries that failed with a 4xx, which Sanity never retries.
- Unpublishing that fires a delete the receiving code ignores, leaving pages cached.
- A publish that will email subscribers, shown before it happens.
