import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("the booking page has no accessibility violations", async ({ page }) => {
  await page.goto("/book");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.length).toBeGreaterThan(0);
});
