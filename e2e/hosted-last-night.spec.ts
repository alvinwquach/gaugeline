// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * The "what happened last night" page in a real browser (X63, part 3).
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { HAS_DATABASE } from "../apps/hosted/db/__tests__/harness.js";
import {
  fixture,
  PEOPLE,
  seedActivity,
  type Fixture,
} from "../apps/hosted/app/__tests__/web-helpers.js";
import { createWebServer } from "../apps/hosted/server/node.js";

test.skip(!HAS_DATABASE, "needs GAUGELINE_TEST_DATABASE_URL (a Postgres server)");

let f: Fixture;
let server: Server;
let origin = "";

test.beforeAll(async () => {
  f = await fixture();
  await seedActivity(f.owner);
  server = createWebServer(f.deps, () => origin);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await f?.drop();
});

test("from the dashboard to last night: new problems first, closed next, page text stays text", async ({
  page,
}) => {
  await page.goto(`${origin}/sign-in`);
  await page.getByLabel("Email address").fill(PEOPLE.maya.email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await page.goto(`${origin}/sign-in/verify?token=${f.inbox.at(-1)!.token}`);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.getByRole("link", { name: "Last night" }).click();
  await expect(page.getByRole("heading", { name: "Last night", level: 1 })).toBeVisible();
  await expect(page.getByText("4 sites. 1 has new problems, 1 had problems closed")).toBeVisible();
  const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
  expect(headings).toEqual(["New problems", "Problems closed", "No change", "Not checked yet"]);
  await expect(page.getByText("2 new, 1 still open, 0 closed.")).toBeVisible();
  await expect(page.getByText("Fix this first: Menu PDF is gone")).toBeVisible();
  await expect(page.getByText("<img src=x onerror=alert(1)>", { exact: false })).toBeVisible();
  await expect(page.locator("main img")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Last night" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);

  await page.getByRole("link", { name: "Sites" }).click();
  await expect(page.locator("table.sites tbody tr").first()).toContainText("The Tidewater Bar");
});
