// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * The hosted dashboard in a real browser (X63, part 2): the site that got worse overnight is at the top with
 * its new finding, page text stays text, and each person sees only their own team's sites.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
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

async function signIn(page: Page, email: string) {
  await page.goto(`${origin}/sign-in`);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.goto(`${origin}/sign-in/verify?token=${f.inbox.at(-1)!.token}`);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("the site that got worse overnight is first, with the new finding shown as text", async ({
  page,
}) => {
  await signIn(page, PEOPLE.maya.email);
  const rows = page.locator("table.sites tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("The Tidewater Bar");
  await expect(rows.nth(0)).toContainText("Worse");
  await expect(rows.nth(0)).toContainText("Fix this first: Menu PDF is gone");
  // The evidence line holds markup the checked site chose: it is shown, not run.
  await expect(rows.nth(0)).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator("main img")).toHaveCount(0);
  await expect(rows.nth(1)).toContainText("Harbour Yoga Studio");
  await expect(rows.nth(1)).toContainText("Still");
  await expect(rows.nth(2)).toContainText("Juniper Pop-up Kitchen");
  await expect(rows.nth(2)).toContainText("Better");
  await expect(rows.nth(3)).toContainText("Linden Bakery");
  await expect(rows.nth(3)).toContainText("Not checked yet");
  await expect(page.getByText("Maple Street Physio")).toHaveCount(0);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
});

test("another team sees only its own site, and a team with no sites is told what to do", async ({
  page,
  browser,
}) => {
  await signIn(page, PEOPLE.ben.email);
  await expect(page.locator("table.sites tbody tr")).toHaveCount(1);
  await expect(page.getByText("Maple Street Physio")).toBeVisible();
  await expect(page.getByText("First check")).toBeVisible();
  await expect(page.getByText("The Tidewater Bar")).toHaveCount(0);

  const other = await browser.newPage();
  await signIn(other, PEOPLE.eve.email);
  await expect(other.getByText("No sites yet")).toBeVisible();
  await expect(other.locator("table")).toHaveCount(0);
  await other.close();
});
