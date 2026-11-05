import { expect, test } from "@playwright/test";

test("/docs/checks?id=canonical-elsewhere shows that check in view and expanded", async ({
  page,
}) => {
  await page.goto("/docs/checks?id=canonical-elsewhere");
  const check = page.locator("details#canonical-elsewhere");
  await expect(check).toHaveAttribute("open", "");
  await expect(check.getByText("This page tells Google to show a different page")).toBeInViewport();
});

test("/docs/checks#host-duplicate does the same for that check", async ({ page }) => {
  await page.goto("/docs/checks#host-duplicate");
  const check = page.locator("details#host-duplicate");
  await expect(check).toHaveAttribute("open", "");
  await expect(check.getByText("Your whole site exists at two addresses")).toBeInViewport();
});

test("/docs/checks?id=nope shows the full list and the note", async ({ page }) => {
  await page.goto("/docs/checks?id=nope");
  await expect(page.getByText('No check has the id "nope". Here is the full list.')).toBeVisible();
  await expect(page.locator("details.check")).toHaveCount(6);
});

test("the area filter set to Visitors hides a Search & sharing check", async ({ page }) => {
  await page.goto("/docs/checks");
  await expect(page.locator("details#noindex")).toBeVisible();
  await page.getByLabel("Filter by area").selectOption("Visitors");
  await expect(page.locator("details#noindex")).toHaveCount(0);
});

test("text with angle brackets renders as text, not markup", async ({ page }) => {
  await page.goto("/docs/checks?id=canonical-elsewhere");
  await expect(page.locator("details#canonical-elsewhere code").last()).toHaveText(
    '<link rel="canonical"> on the page points at another URL',
  );
});

test.describe("with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });
  test("the page still lists every check as static HTML", async ({ page }) => {
    await page.goto("/docs/checks");
    await expect(page.locator("details.check")).toHaveCount(6);
  });
});
