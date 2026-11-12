/**
 * The hosted app's sign-in and page shell in a real browser (X63, part 1). The app runs in this process on
 * a fresh seeded Postgres (skipped when GAUGELINE_TEST_DATABASE_URL is not set), with the stand-in auth
 * whose "inbox" the test reads. No script runs in the page: the pages are server-rendered HTML.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { HAS_DATABASE } from "../apps/hosted/db/__tests__/harness.js";
import { fixture, PEOPLE, type Fixture } from "../apps/hosted/app/__tests__/web-helpers.js";
import { createWebServer } from "../apps/hosted/server/node.js";

test.skip(!HAS_DATABASE, "needs GAUGELINE_TEST_DATABASE_URL (a Postgres server)");

let f: Fixture;
let server: Server;
let origin = "";

test.beforeAll(async () => {
  f = await fixture();
  server = createWebServer(f.deps, () => origin);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await f?.drop();
});

async function requestLink(page: Page, email: string) {
  await page.goto(`${origin}/`);
  await expect(page).toHaveURL(`${origin}/sign-in`);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  return f.inbox.at(-1)!.token;
}

test("sign in by link, see your organisation, switch, sign out", async ({ page }) => {
  const token = await requestLink(page, PEOPLE.both.email);
  await page.goto(`${origin}/sign-in/verify?token=${token}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Brightfield Web" })).toBeVisible();
  await expect(page.getByText("Maple Street Physio")).toBeVisible();
  await expect(page.getByText("Juniper Pop-up Kitchen")).toHaveCount(0);

  await page.getByLabel("Organisation").selectOption({ label: "Northgate Studio" });
  await page.getByRole("button", { name: "Switch" }).click();
  await expect(page.getByRole("heading", { name: "Northgate Studio" })).toBeVisible();
  await expect(page.getByText("Juniper Pop-up Kitchen")).toBeVisible();
  await expect(page.getByText("Maple Street Physio")).toHaveCount(0);

  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(`${origin}/sign-in`);
  await page.goto(`${origin}/`);
  await expect(page).toHaveURL(`${origin}/sign-in`);
});

test("an expired link says so, and the page is accessible", async ({ page }) => {
  const token = await requestLink(page, PEOPLE.maya.email);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
  f.now.t = new Date(f.now.t.getTime() + 20 * 60_000);
  try {
    await page.goto(`${origin}/sign-in/verify?token=${token}`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "That link is expired" })).toBeVisible();
    await page.getByRole("link", { name: "Get a new link" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  } finally {
    f.now.t = new Date(f.now.t.getTime() - 20 * 60_000);
  }
});

test("a client viewer is shown their one site and no controls", async ({ page }) => {
  const token = await requestLink(page, PEOPLE.manager.email);
  await page.goto(`${origin}/sign-in/verify?token=${token}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("The Tidewater Bar")).toBeVisible();
  await expect(page.getByText("Juniper Pop-up Kitchen")).toHaveCount(0);
  await expect(page.getByText("You are signed in as Client viewer.")).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
});
