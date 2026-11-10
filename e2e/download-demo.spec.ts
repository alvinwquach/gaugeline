import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { startFixture, type Fixture } from "../packages/fixtures/src/index.ts";

/** The built CLI (pnpm build runs before this). */
const BIN = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));

let child: ChildProcess | undefined;
const fixtures: Fixture[] = [];

/** `gaugeline open --no-open [...extra]`, resolved with the one-time link it prints. */
async function open(extra: string[]): Promise<string> {
  const c = spawn(process.execPath, [BIN, "open", ...extra, "--no-open"], {
    env: { ...process.env, CI: "" },
  });
  child = c;
  return new Promise<string>((resolve, reject) => {
    let out = "";
    c.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /Gaugeline is running at (\S+)/.exec(out);
      if (m?.[1]) resolve(m[1]);
    });
    c.on("exit", () => reject(new Error(`gaugeline open exited: ${out}`)));
  });
}

test.afterEach(async () => {
  if (child) {
    const exited = new Promise((r) => child?.once("exit", r));
    child.kill("SIGINT");
    await exited;
    child = undefined;
  }
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});

/** Reports, from before the page's first script, every policy violation, console error and dialog. */
async function watchPage(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      problems.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  await page.addInitScript(() => {
    const w = window as unknown as { violations: string[] };
    w.violations = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      w.violations.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return {
    problems,
    violations: () =>
      page.evaluate(() => (window as unknown as { violations: string[] }).violations),
  };
}

const view = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Views" }).getByRole("link", { name });

async function noSeriousViolations(page: Page) {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
}

test("Download the report: the file is named gaugeline-report.html and opens from disk with no network", async ({
  page,
  browser,
}, info) => {
  const watch = await watchPage(page);
  const studio = await startFixture("pages-search");
  fixtures.push(studio);
  const link = await open([]);
  await page.goto(link);
  await page.getByLabel("Address to check").fill(studio.origin);
  await page.getByLabel("Address to check").press("Enter");
  await expect(page.getByRole("heading", { name: "What looked right" })).toBeVisible({
    timeout: 20_000,
  });

  const anchor = page.getByRole("link", { name: "Download the report" });
  await expect(anchor).toBeVisible();
  expect(await anchor.getAttribute("download")).toBe("gaugeline-report.html");
  const [download] = await Promise.all([page.waitForEvent("download"), anchor.click()]);
  expect(download.suggestedFilename()).toBe("gaugeline-report.html");
  const saved = info.outputPath("gaugeline-report.html");
  await download.saveAs(saved);
  // The app stays where it was: the download is not a navigation.
  await expect(page.getByRole("heading", { name: "What looked right" })).toBeVisible();

  // Opened from disk in a fresh page: it is the report, and nothing is requested but itself.
  const html = readFileSync(saved, "utf8");
  expect(html).toContain("<h1>Gaugeline report</h1>");
  expect(html).toContain("<style>");
  const context = await browser.newContext({ javaScriptEnabled: true });
  const file = await context.newPage();
  const requested: string[] = [];
  file.on("request", (r) => requested.push(r.url()));
  await file.goto(pathToFileURL(saved).href);
  await expect(file.getByRole("heading", { level: 1, name: "Gaugeline report" })).toBeVisible();
  // Only the file itself: no address that is not a file: address was asked for.
  expect(requested.length).toBeGreaterThan(0);
  expect(requested.filter((u) => !u.startsWith("file:"))).toEqual([]);
  await context.close();

  expect(watch.problems).toEqual([]);
  expect(await watch.violations()).toEqual([]);
});

test("the report route is a download, never a page: opening its address saves a file and leaves the app", async ({
  page,
}) => {
  const studio = await startFixture("clean");
  fixtures.push(studio);
  const link = await open([]);
  await page.goto(link);
  await page.getByLabel("Address to check").fill(studio.origin);
  await page.getByLabel("Address to check").press("Enter");
  await expect(page.getByRole("heading", { name: "What looked right" })).toBeVisible({
    timeout: 20_000,
  });
  const href = await page.getByRole("link", { name: "Download the report" }).getAttribute("href");
  const answer = await page.request.get(new URL(href ?? "", page.url()).href);
  expect(answer.status()).toBe(200);
  expect(answer.headers()["content-disposition"]).toBe(
    'attachment; filename="gaugeline-report.html"',
  );
  expect(answer.headers()["content-security-policy"]).toBe("sandbox");
  expect(answer.headers()["cache-control"]).toBe("no-store");
});

test("gaugeline open --demo: the banner shows and all five views render, and no request leaves this computer", async ({
  page,
}) => {
  const watch = await watchPage(page);
  const origins = new Set<string>();
  page.on("request", (r) => origins.add(new URL(r.url()).hostname));
  const link = await open(["--demo"]);
  await page.goto(link);

  const banner = page.getByRole("note");
  await expect(banner).toContainText("Example results");
  await expect(banner).toContainText(
    "This is the demo. Run npx gaugeline open yoursite.com to check a real page.",
  );
  await expect(page.getByLabel("Address to check")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Check" })).toBeDisabled();

  // The three example runs are listed; the newest is open.
  const sidebar = page.getByRole("navigation", { name: "Pages checked this session" });
  await expect(sidebar.getByRole("link")).toHaveCount(3);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What looked right" })).toBeVisible();
  await noSeriousViolations(page);

  await view(page, "Problems").click();
  await expect(page.getByRole("heading", { level: 1, name: "Problems" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("heading", { level: 3 }).first()).toBeVisible();

  await view(page, "Pages checked").click();
  await expect(page.getByRole("heading", { level: 1, name: "Pages checked" })).toBeVisible();
  await expect(page.getByRole("main").locator("table tbody tr").first()).toBeVisible();
  // Addresses are the invented ones.
  await expect(page.getByRole("main")).toContainText("https://shop.example/");

  await view(page, "Search data").click();
  await expect(page.getByRole("heading", { level: 1, name: "Search data" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Larkspur Pottery Studio");

  // The wine bar's run has the leaks to show.
  await sidebar.getByRole("link", { name: /wine-bar\.example/ }).click();
  await view(page, "Leaks & access").click();
  await expect(page.getByRole("heading", { level: 1, name: "Leaks & access" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("production");
  await noSeriousViolations(page);

  // A report can be downloaded from the demo too: it is about the invented site.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download the report" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("gaugeline-report.html");

  // Every request this page made went to the app itself.
  expect([...origins].filter((h) => h !== "localhost" && h !== "127.0.0.1")).toEqual([]);
  expect(watch.problems).toEqual([]);
  expect(await watch.violations()).toEqual([]);
});
