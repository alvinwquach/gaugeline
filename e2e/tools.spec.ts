import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const LIST = readFileSync(
  new URL("../packages/fixtures/redirects/redirect-list.csv", import.meta.url),
  "utf8",
);

test("pasting the fixture list reports its duplicate, chain and self-pointing row, with no request", async ({
  page,
}) => {
  await page.goto("/docs/tools/redirects");
  const asked: string[] = [];
  page.on("request", (r) => asked.push(r.url()));
  await page.getByTestId("redirect-input").fill(LIST);
  await page.getByTestId("redirect-check").click();
  const results = page.getByTestId("redirect-results");
  await expect(results.getByText("3 problems in 8 redirects, found in this page:")).toBeVisible();
  await expect(results.locator("li[data-rule]")).toHaveCount(3);
  await expect(results.locator('li[data-rule="duplicate"]')).toContainText(
    "/old-gifts is listed 2 times with different destinations (lines 5, 6)",
  );
  await expect(results.locator('li[data-rule="chain"]')).toContainText(
    "Line 8: /about-us → /old-about, which line 7 redirects again to /about",
  );
  await expect(results.locator('li[data-rule="self"]')).toContainText(
    "Line 9: /press redirects to itself",
  );
  await expect(page.getByTestId("redirect-command")).toContainText("npx gaugeline plan");
  // Linting happened in the page: nothing was sent anywhere.
  expect(asked.filter((u) => u.includes("/api/"))).toEqual([]);
});

test("a file in the wrong shape gets a plain explanation", async ({ page }) => {
  await page.goto("/docs/tools/redirects");
  await page.getByTestId("redirect-input").fill("Name,Price\nMug,12");
  await page.getByTestId("redirect-check").click();
  await expect(page.getByTestId("redirect-problem")).toContainText(
    "Put the old address first and the new one second",
  );
});

test("the plan checker reports an old address with no destination and a shared title", async ({
  page,
}) => {
  await page.goto("/docs/tools/plan");
  await page
    .getByTestId("plan-input")
    .fill("Old URL,New URL,Title\n/old-a,/a,Fiction\n/old-b,,Poetry\n/old-c,/c,Fiction");
  await page.getByTestId("plan-check").click();
  await expect(page.locator('li[data-rule="shared-title"]')).toContainText(
    'share the title "Fiction"',
  );
  await expect(page.locator('li[data-rule="no-destination"]')).toContainText(
    "Line 3: /old-b has no new address",
  );
  await expect(page.getByTestId("plan-command")).toContainText(
    "npx gaugeline plan plan.csv --plan-only",
  );
});
