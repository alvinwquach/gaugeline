import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { startFixture, type Fixture } from "../packages/fixtures/src/index.ts";

/** The built CLI (pnpm build runs before this). */
const BIN = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));

let child: ChildProcess;
let link = "";
const fixtures: Fixture[] = [];
const servers: Server[] = [];

/** An invented fixture site, served for this test and closed after it. */
async function site(name: string): Promise<Fixture> {
  const f = await startFixture(name);
  fixtures.push(f);
  return f;
}

/** A one-page site made for a test: the page's HTML and how long it takes to answer. */
async function inlineSite(html: string, delayMs = 0): Promise<string> {
  const server = createServer((req, res) => {
    const send = () =>
      req.url === "/"
        ? res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html)
        : res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    if (delayMs > 0 && req.url === "/") setTimeout(send, delayMs);
    else send();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// A fresh `gaugeline open` for each test: its link works once, and each test is a new browser.
test.beforeEach(async () => {
  child = spawn(process.execPath, [BIN, "open", "--no-open"], { env: { ...process.env, CI: "" } });
  link = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /Gaugeline is running at (\S+)/.exec(out);
      if (m?.[1]) resolve(m[1]);
    });
    child.on("exit", () => reject(new Error(`gaugeline open exited: ${out}`)));
  });
});
test.afterEach(async () => {
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGINT");
  await exited;
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/**
 * Records, from before the page's first script, every browser-reported policy violation and every
 * list item added under a polite live region (the step lines, which are gone once a run is done).
 */
async function watchPage(page: Page) {
  const problems: string[] = [];
  const hosts = new Set<string>();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      problems.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("dialog", (d) => {
    problems.push(`dialog: ${d.message()}`);
    void d.dismiss();
  });
  page.on("request", (r) => hosts.add(new URL(r.url()).host));
  await page.addInitScript(() => {
    const w = window as unknown as { violations: string[]; steps: string[] };
    w.violations = [];
    w.steps = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      w.violations.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLElement && n.matches('[aria-live="polite"] > li'))
            w.steps.push(n.textContent ?? "");
    }).observe(document, { childList: true, subtree: true });
  });
  return {
    problems,
    hosts,
    violations: () =>
      page.evaluate(() => (window as unknown as { violations: string[] }).violations),
    steps: () => page.evaluate(() => (window as unknown as { steps: string[] }).steps),
  };
}

const sidebar = (page: Page) =>
  page.getByRole("navigation", { name: "Pages checked this session" });

/** Type an address and press Enter. */
async function check(page: Page, address: string) {
  await page.getByLabel("Address to check").fill(address);
  await page.getByLabel("Address to check").press("Enter");
}

/** The count shown for one level in the Overview. */
const level = (page: Page, label: string) =>
  page.getByRole("main").locator(".level", { hasText: label }).locator(".level-count");

test("open the link, check a fixture, watch the steps, land on Overview with the right counts", async ({
  page,
}) => {
  const watch = await watchPage(page);
  const images = await site("images");
  await page.goto(link);
  await expect(page.getByRole("heading", { level: 1, name: "Check a page" })).toBeVisible();

  await check(page, images.origin);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(level(page, "Fix this first")).toHaveText("1");
  await expect(level(page, "Fix soon")).toHaveText("3");
  await expect(level(page, "Worth knowing")).toHaveText("2");
  // Where to start: the first three, the broken images first.
  await expect(
    page.getByRole("heading", { level: 3, name: "Some images on this page don't load" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "What looked right" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How much was checked" })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "How much was checked" })
      .getByRole("listitem")
      .filter({ hasText: /images? checked/ }),
  ).toBeVisible();

  // The step lines arrived in the live region while it ran, in the words of the terminal.
  const steps = await watch.steps();
  expect(steps).toContain("Loading the page without JavaScript");
  expect(steps).toContain("Reading robots.txt and the sitemap");

  // The new run is in the sidebar, selected, and in the address bar.
  await expect(sidebar(page).getByRole("link", { current: "page" })).toContainText(images.origin);
  await expect(sidebar(page).getByRole("link", { current: "page" })).toContainText("Done");
  expect(new URL(page.url()).hash).toMatch(/^#\/[^/]+\/overview$/);
  // The field was cleared when the check started.
  await expect(page.getByLabel("Address to check")).toHaveValue("");

  expect(await watch.violations()).toEqual([]);
  expect(watch.problems).toEqual([]);
  expect([...watch.hosts]).toEqual([new URL(link).host]);
});

test("a second address joins the sidebar, and selecting the first needs no new request to its site", async ({
  page,
}) => {
  const images = await site("images");
  const clean = await site("clean");
  await page.goto(link);
  await check(page, images.origin);
  await expect(level(page, "Fix this first")).toHaveText("1");
  await check(page, clean.origin);
  await expect(page.getByText("Nothing to fix. Every check that ran passed.")).toBeVisible();

  const links = sidebar(page).getByRole("link");
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toContainText(images.origin);
  await expect(links.nth(1)).toContainText(clean.origin);
  await expect(links.nth(1)).toHaveAttribute("aria-current", "page");
  // Counts by level in the sidebar.
  await expect(links.nth(0)).toContainText("1 Fix this first");
  await expect(links.nth(0)).toContainText("3 Fix soon");
  await expect(links.nth(0)).toContainText("2 Worth knowing");

  const before = images.total;
  await links.nth(0).click();
  await expect(links.nth(0)).toHaveAttribute("aria-current", "page");
  await expect(level(page, "Fix soon")).toHaveText("3");
  expect(images.total).toBe(before);
});

test("a reload lists both runs again and restores the selected one from the address", async ({
  page,
}) => {
  const images = await site("images");
  const clean = await site("clean");
  await page.goto(link);
  await check(page, images.origin);
  await expect(level(page, "Fix soon")).toHaveText("3");
  await check(page, clean.origin);
  await expect(page.getByText("Nothing to fix. Every check that ran passed.")).toBeVisible();
  const links = sidebar(page).getByRole("link");
  await links.nth(0).click();
  await expect(level(page, "Fix soon")).toHaveText("3");
  const hash = new URL(page.url()).hash;

  await page.reload();
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute("aria-current", "page");
  await expect(level(page, "Fix soon")).toHaveText("3");
  expect(new URL(page.url()).hash).toBe(hash);
});

test("a hash that names a run that is gone falls back to the newest run", async ({ page }) => {
  const clean = await site("clean");
  await page.goto(link);
  await check(page, clean.origin);
  await expect(page.getByText("Nothing to fix. Every check that ran passed.")).toBeVisible();
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/#/no-such-run/overview`);
  await page.reload();
  await expect(sidebar(page).getByRole("link", { current: "page" })).toContainText(clean.origin);
  expect(new URL(page.url()).hash).not.toContain("no-such-run");
});

test("a page title that is markup is shown as text and opens no dialog", async ({ page }) => {
  const watch = await watchPage(page);
  const origin = await inlineSite(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title><img src=x onerror=alert(1)></title><title>Second title</title></head><body><h1>Hello</h1></body></html>`,
  );
  await page.goto(link);
  await check(page, origin);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByRole("main").getByText("<img src=x onerror=alert(1)>")).toBeVisible();
  expect(await page.getByRole("main").locator("img").count()).toBe(0);
  await page.waitForTimeout(300);
  expect(watch.problems).toEqual([]);
});

test("a 300-character address is cut short on screen and whole for a screen reader", async ({
  page,
}) => {
  const clean = await site("clean");
  const address = `${clean.origin}/${"a".repeat(290)}`;
  await page.goto(link);
  await check(page, address);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  const current = sidebar(page).getByRole("link", { current: "page" });
  const url = current.locator(".run-url");
  await expect(url).toHaveText(address);
  const cut = await url.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(cut).toBe(true);
  // The link's accessible name carries the whole address.
  await expect(
    sidebar(page).getByRole("link", { name: new RegExp(`${"a".repeat(290)}`) }),
  ).toBeVisible();
  // And the sidebar did not push the page sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("keyboard only: the form, the sidebar and the views come in order, and axe finds nothing serious", async ({
  page,
}) => {
  const images = await site("images");
  const clean = await site("clean");
  await page.goto(link);
  await check(page, images.origin);
  await expect(level(page, "Fix soon")).toHaveText("3");
  await check(page, clean.origin);
  await expect(page.getByText("Nothing to fix. Every check that ran passed.")).toBeVisible();

  // Start from the top of the page: a click on the name sets the starting point for Tab.
  await page.locator(".brand").click();
  const focused = async () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return `${el.tagName.toLowerCase()}:${(el.getAttribute("aria-label") ?? el.textContent ?? "").slice(0, 40)}`;
    });
  const order: string[] = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    order.push(await focused());
  }
  expect(order[0]).toMatch(/^input/);
  expect(order[1]).toBe("button:Check");
  expect(order[2]).toContain(images.origin.slice(0, 20));
  expect(order[3]).toContain(clean.origin.slice(0, 20));
  expect(order[4]).toBe("a:Overview");
  // Focus is visible: the browser draws an outline on the focused link.
  const outline = await page.evaluate(
    () => getComputedStyle(document.activeElement as Element).outlineStyle,
  );
  expect(outline).not.toBe("none");

  // Enter on a sidebar link selects it.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(sidebar(page).getByRole("link").nth(0)).toHaveAttribute("aria-current", "page");

  const axe = await new AxeBuilder({ page }).analyze();
  const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
});

test("the server's sentence for a refused address is shown next to the field", async ({ page }) => {
  // Built from parts: a user:password@host address is what the check refuses, and not an email address.
  const withLogin = ["http://", "user", ":", "pass", "@", "shop.example/"].join("");
  await page.goto(link);
  await check(page, withLogin);
  await expect(page.getByRole("alert")).toHaveText(
    "Leave the username and password out of the address.",
  );
  await expect(page.getByLabel("Address to check")).toHaveValue(withLogin);
  await check(page, "   ");
  await expect(page.getByRole("alert")).toHaveText("Enter an address, such as yoursite.com.");
});

test("an event stream that drops mid-run recovers without repeating a step line", async ({
  page,
}) => {
  const watch = await watchPage(page);
  // The page answers after 2.5 s, so the run is still going when the stream is cut and when it reopens.
  const origin = await inlineSite(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Slow</title></head><body><h1>Slow</h1></body></html>`,
    2500,
  );
  let cut = false;
  await page.route("**/api/runs/*/events", async (route) => {
    if (!cut) {
      cut = true;
      await route.abort("connectionreset");
    } else await route.continue();
  });
  await page.goto(link);
  await check(page, origin);
  await expect(page.getByRole("heading", { name: "Checking this page" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What was found" })).toBeVisible({
    timeout: 15_000,
  });
  expect(cut).toBe(true);
  const steps = await watch.steps();
  expect(steps.length).toBeGreaterThan(0);
  expect(new Set(steps).size).toBe(steps.length);
});
