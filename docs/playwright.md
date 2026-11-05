---
notReleased: true
---

# Playwright helper

Test every page with your real content.

```ts title=prices.spec.ts
import { test, expect } from "@gaugeline/playwright";

test("every product shows the checkout price", async ({ page, content }) => {
  for (const product of await content.published("product")) {
    await page.goto(product.url);
    await expect(page.getByTestId("price")).toHaveText(product.checkoutPrice);
  }
});
```
