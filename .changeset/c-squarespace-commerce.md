---
"gaugeline": minor
---

Squarespace commerce: price and stock checks for stores built on Squarespace. A new adapter reads a store's products and stock through the Commerce APIs with an API key that can only read, and two new checks find a product page whose price (`squarespace-price-differs`) or stock (`squarespace-stock-differs`) differs from the store. Squarespace has no read API for pages or blog posts, so those stay live-site only.
