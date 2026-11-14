import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { startFixture, type Fixture } from "../packages/fixtures/src/index.ts";
import type { RequestRow, RunDetail } from "../packages/app/src/types.ts";

/** The built CLI (pnpm build runs before this). */
const BIN = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));
const FIXTURE_HTML = fileURLToPath(
  new URL("../packages/fixtures/sites/pages-search/index.html", import.meta.url),
);

let child: ChildProcess;
let link = "";
const fixtures: Fixture[] = [];

async function site(name: string): Promise<Fixture> {
  const f = await startFixture(name);
  fixtures.push(f);
  return f;
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
});

/** Reports, from before the page's first script, every policy violation, console error and dialog. */
async function watchPage(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      problems.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("dialog", (d) => {
    problems.push(`dialog: ${d.message()}`);
    void d.dismiss();
  });
  await page.addInitScript(() => {
    const w = window as unknown as { violations: string[]; shift: number };
    w.violations = [];
    w.shift = 0;
    document.addEventListener("securitypolicyviolation", (e) =>
      w.violations.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
        if (!e.hadRecentInput) w.shift += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  return {
    problems,
    violations: () =>
      page.evaluate(() => (window as unknown as { violations: string[] }).violations),
    resetShift: () => page.evaluate(() => ((window as unknown as { shift: number }).shift = 0)),
    shift: () => page.evaluate(() => (window as unknown as { shift: number }).shift),
  };
}

/** Check a fixture and wait until the Overview has what looked right. */
async function check(page: Page, origin: string) {
  await page.goto(link);
  await page.getByLabel("Address to check").fill(origin);
  await page.getByLabel("Address to check").press("Enter");
  await expect(page.getByRole("heading", { name: "What looked right" })).toBeVisible({
    timeout: 15_000,
  });
}

const view = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Views" }).getByRole("link", { name });

const bodyRows = (page: Page) => page.getByRole("main").locator("table tbody tr");

test("Pages checked: one row for each request the fixture saw, by kind, with the redirect as three rows", async ({
  page,
}) => {
  const watch = await watchPage(page);
  const studio = await site("pages-search");
  await check(page, studio.origin);
  await view(page, "Pages checked").click();
  await expect(page.getByRole("heading", { level: 1, name: "Pages checked" })).toBeVisible();
  await expect(page.getByRole("main").locator("table caption")).toContainText("Showing");

  // The run is finished: the server has seen every request there will be.
  const total = studio.total;
  await expect(bodyRows(page)).toHaveCount(total);
  await expect(page.getByRole("main").locator("table caption")).toHaveText(
    `Showing ${total} of ${total} addresses`,
  );

  const answers = await bodyRows(page).evaluateAll((trs) =>
    trs.map((tr) => ({
      address: tr.querySelector("th code")?.textContent ?? "",
      kind: tr.querySelectorAll("td")[0]?.textContent ?? "",
      answer: tr.querySelectorAll("td")[2]?.textContent ?? "",
    })),
  );
  const origin = studio.origin;
  // /moved -> /moved-again -> /about: two rows that moved, then the page that loaded.
  const moved = answers.filter((a) => a.kind === "Link" && a.answer.startsWith("Moved to"));
  expect(moved.map((a) => a.answer)).toEqual(
    expect.arrayContaining([`Moved to ${origin}/moved-again`, `Moved to ${origin}/about`]),
  );
  expect(answers.find((a) => a.address === `${origin}/gone`)?.answer).toBe("Not found");
  expect(answers.find((a) => a.address === `${origin}/busy`)?.answer).toBe("Server error");
  expect(answers.find((a) => a.address === `${origin}/img/missing.png`)?.answer).toBe("Not found");
  // By kind: the page first, then links, images, sitemap pages, the feed, the script, the rest.
  const order = [
    "Page",
    "Link",
    "Image",
    "Sitemap page",
    "Feed",
    "JavaScript file",
    "Other page",
    "Other",
  ];
  const ranks = answers.map((a) => order.indexOf(a.kind));
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  expect(ranks.every((r) => r >= 0)).toBe(true);

  // Addresses are text: no link anywhere in the table.
  await expect(page.getByRole("main").locator("table a")).toHaveCount(0);
  const hash = new URL(page.url()).hash;
  await bodyRows(page).first().locator("th code").click();
  expect(new URL(page.url()).hash).toBe(hash);

  // Only problems: everything that did not end in a 2xx, and the count follows.
  const problems = answers.filter((a) => a.answer !== "Loaded").length;
  await page.getByRole("button", { name: /^Only problems/ }).click();
  await expect(bodyRows(page)).toHaveCount(problems);
  await expect(page.getByRole("main").locator("table caption")).toHaveText(
    `Showing ${problems} of ${total} addresses`,
  );

  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
  expect(await watch.violations()).toEqual([]);
  expect(watch.problems).toEqual([]);
});

test("Search data: the title and canonical equal the fixture's HTML source, and the blocks read", async ({
  page,
}) => {
  const watch = await watchPage(page);
  const studio = await site("pages-search");
  await check(page, studio.origin);
  await view(page, "Search data").click();
  await expect(page.getByRole("heading", { level: 1, name: "Search data" })).toBeVisible();

  const source = readFileSync(FIXTURE_HTML, "utf8").replaceAll("{{origin}}", studio.origin);
  const title = /<title>([^<]*)<\/title>/.exec(source)?.[1];
  const canonical = /<link rel="canonical" href="([^"]*)"/.exec(source)?.[1];
  expect(title).toBeTruthy();
  const dd = (label: string) => page.getByRole("main").locator(`dt:text-is("${label}") + dd`);
  await expect(dd("Title")).toHaveText(title as string);
  await expect(dd("Canonical")).toHaveText(canonical as string);
  await expect(dd("Readable words")).not.toHaveText("0");

  // Three blocks in document order: a product, a graph and one that does not parse.
  const blocks = page.getByRole("main").locator("li.block");
  await expect(blocks).toHaveCount(3);
  await expect(blocks.nth(0).getByRole("heading")).toHaveText("Block 1: Product");
  await expect(blocks.nth(1).getByRole("heading")).toHaveText("Block 2: Organization, WebSite");
  await expect(blocks.nth(2).getByRole("heading")).toHaveText("Block 3: Could not be read");
  await expect(blocks.nth(2).locator("pre")).toContainText('"@type": "LocalBusiness"');
  await expect(blocks.nth(2).locator(".parse-error")).not.toBeEmpty();
  // The offer is open to its price, with no braces; closing it hides the price.
  await expect(blocks.nth(0)).toContainText("24.00");
  await blocks
    .nth(0)
    .getByRole("button", { name: /^offers/ })
    .click();
  await expect(blocks.nth(0)).not.toContainText("24.00");
  await expect(blocks.nth(0)).not.toContainText("{");

  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
  expect(await watch.violations()).toEqual([]);
  expect(watch.problems).toEqual([]);
});

/** Make the run's detail say what a test needs, the way the server would have sent it. */
async function rewrite(
  page: Page,
  change: (checked: NonNullable<RunDetail["checked"]>) => void,
): Promise<void> {
  await page.route(/\/api\/runs\/[^/]+$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as RunDetail;
    if (body.checked) change(body.checked);
    await route.fulfill({ response, json: body });
  });
}

test("Pages checked with every limit full: about 95 rows, nothing moves, and a javascript: address is only text", async ({
  page,
}) => {
  const watch = await watchPage(page);
  const studio = await site("pages-search");
  const full: RequestRow[] = [];
  const add = (kind: RequestRow["kind"], n: number) => {
    for (let i = 0; i < n; i++)
      full.push({
        url: `https://shop.example/${kind}/${i}`,
        kind,
        method: kind === "page" || kind === "script" || kind === "feed" ? "GET" : "HEAD",
        status: i % 7 === 3 ? 404 : 200,
        ms: 10 + i,
      });
  };
  add("page", 1);
  add("link", 30);
  add("image", 20);
  add("sitemap", 25);
  add("feed", 3);
  add("script", 15);
  full.push({
    url: "javascript:alert(1)",
    kind: "link",
    method: "HEAD",
    status: null,
    error: "no-answer",
    ms: 0,
  });
  await rewrite(page, (c) => {
    c.requests = full;
  });
  await check(page, studio.origin);
  await watch.resetShift();
  await view(page, "Pages checked").click();
  await expect(bodyRows(page)).toHaveCount(95);
  await expect(page.getByRole("main").locator("table caption")).toHaveText(
    "Showing 95 of 95 addresses",
  );
  await page.waitForTimeout(300);
  expect(await watch.shift()).toBe(0);

  const hostile = page.getByRole("main").locator("table code", { hasText: "javascript:alert(1)" });
  await expect(hostile).toHaveCount(1);
  await hostile.click();
  expect(await page.locator("table a").count()).toBe(0);
  expect(watch.problems).toEqual([]);
  expect(await watch.violations()).toEqual([]);
});

test("Search data: markup is text, a right-to-left title keeps its direction, and no words points to Problems", async ({
  page,
}) => {
  const watch = await watchPage(page);
  const studio = await site("pages-search");
  const evil = "</script><script>alert(1)</script>";
  await rewrite(page, (c) => {
    c.page.title =
      "\u05E1\u05D8\u05D5\u05D3\u05D9\u05D5 \u05DC\u05E7\u05E8\u05DE\u05D9\u05E7\u05D4";
    c.page.words = 0;
    c.page.firstWords = "";
    c.page.blocks = [{ ok: true, value: { "@type": "Product", name: evil } }];
  });
  await check(page, studio.origin);
  await view(page, "Search data").click();
  await expect(page.getByRole("main").locator('dd span[dir="auto"]').first()).toHaveText(
    "\u05E1\u05D8\u05D5\u05D3\u05D9\u05D5 \u05DC\u05E7\u05E8\u05DE\u05D9\u05E7\u05D4",
  );
  await expect(page.getByRole("main").locator("li.block")).toContainText(evil);
  await expect(page.getByText(/no words a visitor can read without JavaScript/)).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("link", { name: /almost empty page|Problems/ })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Problems" })).toBeVisible();
  expect(watch.problems).toEqual([]);
  expect(await watch.violations()).toEqual([]);
});
