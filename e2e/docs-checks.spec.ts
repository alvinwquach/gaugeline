import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/** Every check in the generated reference: the page must list them all. */
const CHECK_COUNT = (
  JSON.parse(
    readFileSync(new URL("../docs/checks.data.json", import.meta.url), "utf8"),
  ) as unknown[]
).length;

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
  await expect(page.locator("details.check")).toHaveCount(CHECK_COUNT);
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
    await expect(page.locator("details.check")).toHaveCount(CHECK_COUNT);
  });
});

test("a released check shows Since v0.1.0 and the badge is in the heading row and the details", async ({
  page,
}) => {
  await page.goto("/docs/checks?id=canonical-elsewhere");
  const check = page.locator("details#canonical-elsewhere");
  await expect(check.locator("summary .since")).toHaveText("Since v0.1.0");
  await expect(check.locator("summary .since")).toHaveAttribute("data-released", "true");
  await expect(check.getByText("Since v0.1.0").last()).toBeVisible();
});

test("every check has a Since badge, and an unreleased one says it is the next version", async ({
  page,
}) => {
  await page.goto("/docs/checks");
  await expect(page.locator("details.check .since")).toHaveCount(CHECK_COUNT);
  const pending = page.locator('details.check .since[data-released="false"]');
  // Once a release has stamped every check there is no unreleased one to look at.
  test.skip((await pending.count()) === 0, "every check is released");
  const unreleased = pending.first();
  await expect(unreleased).toContainText("(next)");
  await expect(unreleased).toHaveAttribute("title", /Not released yet/);
});
