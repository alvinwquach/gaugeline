import { expect, test } from "@playwright/test";
import { NAV } from "../docs/nav.js";

test("/docs/quick-start renders the Run a check heading and the Terminal block", async ({
  page,
}) => {
  await page.goto("/docs/quick-start");
  await expect(page.getByRole("heading", { name: "Run a check" })).toBeVisible();
  await expect(page.locator("div.language-sh").first()).toContainText("npx gaugeline shop.example");
});

test("opening /#/docs/options lands on /docs/options", async ({ page }) => {
  await page.goto("/#/docs/options");
  await page.waitForURL("**/docs/options");
  await expect(page.getByRole("heading", { level: 1, name: "Options" })).toBeVisible();
});

test("opening /#/docs/checks?id=canonical-elsewhere keeps the query", async ({ page }) => {
  await page.goto("/#/docs/checks?id=canonical-elsewhere");
  await page.waitForURL(
    (u) => u.pathname === "/docs/checks" && u.search === "?id=canonical-elsewhere",
  );
  expect(new URL(page.url()).search).toBe("?id=canonical-elsewhere");
});

test("pages marked soon show the Not released yet callout", async ({ page }) => {
  const soon = NAV.flatMap((g) => g.pages.filter((p) => p.soon || g.soon));
  expect(soon.length).toBeGreaterThan(0);
  for (const p of soon) {
    await page.goto(`/docs/${p.slug}`);
    await expect(
      page.locator(".custom-block").filter({ hasText: "Not released yet" }).first(),
      p.slug,
    ).toBeVisible();
  }
});

test("a hash that is not a docs route (#/security) is left alone", async ({ page }) => {
  await page.goto("/#/security");
  await page.waitForTimeout(500);
  const url = new URL(page.url());
  expect(url.pathname).toBe("/");
  expect(url.hash).toBe("#/security");
});
