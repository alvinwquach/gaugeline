import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { startApp, type RunningApp } from "../packages/app-server/src/index.ts";

let app: RunningApp;
let other: Server;
let otherOrigin = "";

// A fresh app for each test: its link works once, and each test is a new browser.
test.beforeEach(async () => {
  app = await startApp({ port: 5200 });
});
test.afterEach(async () => {
  await app.close();
});

test.beforeAll(async () => {
  // A second origin: a page that tries to drive the app with the browser's credentials.
  other = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>waiting</title>
<script>
fetch("http://localhost:" + new URLSearchParams(location.search).get("port") + "/", { credentials: "include" })
  .then((r) => { document.title = "answered " + r.status; })
  .catch(() => { document.title = "failed"; });
</script>`);
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
  otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => other.close(() => r()));
});

test("the printed link ends at / with no key in the address bar, and a reload still loads", async ({
  page,
}) => {
  await page.goto(app.url);
  expect(new URL(page.url()).search).toBe("");
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.getByText("Gaugeline is running on this computer")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Gaugeline is running on this computer")).toBeVisible();
});

test("a page on another origin can't drive the app, even with credentials", async ({ page }) => {
  await page.goto(app.url);
  await expect(page.getByText("Gaugeline is running on this computer")).toBeVisible();
  const before = app.accepted();
  await page.goto(`${otherOrigin}/?port=${app.port}`);
  await expect(page).toHaveTitle(/failed|answered/);
  expect(await page.title()).toBe("failed");
  expect(app.accepted()).toBe(before);
});
