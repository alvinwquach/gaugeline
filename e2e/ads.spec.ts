import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  startApp,
  type AdsData,
  type AdsEngine,
  type RunningApp,
} from "../packages/app-server/src/index.ts";
import { startFixture, type Fixture } from "../packages/fixtures/src/index.ts";
import { buildResult } from "@gaugeline/core";

const CLIENT_DIR = fileURLToPath(new URL("../packages/cli/dist/client", import.meta.url));

let app: RunningApp | undefined;
let fixture: Fixture | undefined;
let dir: string | undefined;

test.afterEach(async () => {
  await app?.close();
  await fixture?.close();
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  app = fixture = dir = undefined;
});

/**
 * 12 ads over 4 landing pages of an invented tapas bar, one of them dead. The stand-in for the ads
 * command asks for each page once (a GET through the app's fetcher) and reports a finding for any
 * that does not load; the figures are the export's.
 */
const PAGES = [
  { path: "/", ads: 5, spend: 120450 },
  { path: "/about.html", ads: 3, spend: 80000 },
  { path: "/menu.html", ads: 3, spend: 15075 },
  { path: "/old-menu.html", ads: 1, spend: 99999 },
];

function engine(origin: string): AdsEngine<string> {
  const data: AdsData = {
    currencies: [
      {
        currency: "USD",
        destinations: PAGES.map((p) => ({ url: `${origin}${p.path}`, ads: p.ads, spend: p.spend })),
      },
    ],
  };
  return {
    read: (text) => text,
    async check(_text, ctx) {
      ctx.onProgress("Checking 4 landing pages");
      const findings = [];
      for (const d of data.currencies[0]?.destinations ?? []) {
        const hops = await ctx.fetcher.get(d.url);
        const status = hops[hops.length - 1]?.status ?? 0;
        if (status >= 400)
          findings.push({
            checkId: "page-dead",
            severity: "high" as const,
            title: "The page does not load",
            evidence: `${d.url} answered ${status}`,
            url: d.url,
          });
      }
      return {
        result: buildResult({
          url: "campaña de otoño.csv",
          startedAt: ctx.now,
          findings,
          passed: [],
          failed: [],
          couldNotCheck: [],
          sampled: {},
        }),
        ads: data,
      };
    },
  };
}

async function start(): Promise<{ link: string; site: Fixture }> {
  const site = await startFixture("clean");
  fixture = site;
  dir = mkdtempSync(join(tmpdir(), "gaugeline-ads-e2e-"));
  const folder = join(dir, "Clientes de María");
  mkdirSync(folder);
  const file = join(folder, "campaña de otoño.csv");
  writeFileSync(file, "Ad name,Website URL,Amount spent (USD)\n");
  app = await startApp({
    clientDir: CLIENT_DIR,
    fetcher: { allowPrivate: true },
    ads: { file, engine: engine(site.origin) },
  });
  await app.firstRun;
  return { link: app.url, site };
}

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

test("the export opens on Ads: the summary, the dead page first, and its finding opens in Problems", async ({
  page,
}) => {
  const watch = await watchPage(page);
  const hosts = new Set<string>();
  page.on("request", (r) => hosts.add(new URL(r.url()).hostname));
  const { link, site } = await start();
  await page.goto(link);

  // The sidebar names the file, never the folder.
  const sidebar = page.getByRole("navigation", { name: "Pages checked this session" });
  await expect(sidebar.getByRole("link")).toHaveCount(1);
  await expect(sidebar).toContainText("campaña de otoño.csv");
  await expect(sidebar).not.toContainText("Clientes");

  await expect(page.getByRole("heading", { level: 1, name: "Ads" })).toBeVisible();
  await expect(page.locator(".ads-summary")).toHaveText(
    "$999.99 of $3,155.24 went to pages with problems.",
  );
  // Ads has no Overview beside it, and nothing to download.
  const views = page.getByRole("navigation", { name: "Views" }).getByRole("link");
  await expect(views).toHaveText(["Ads", "Problems"]);
  await expect(page.getByRole("link", { name: "Download the report" })).toHaveCount(0);

  const rows = page.getByRole("main").locator("table tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText("/old-menu.html");
  await expect(rows.first()).toContainText("$999.99");
  await expect(rows.nth(1)).toContainText("$1,204.50");

  // The filter keeps the one page with a problem.
  await page.getByRole("button", { name: "Only pages with problems (1)" }).click();
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "Only pages with problems (1)" }).click();
  await expect(rows).toHaveCount(4);

  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id),
  ).toEqual([]);

  // Opening the finding lands in Problems, on that finding, where it can be copied as a note.
  await rows.first().getByRole("link", { name: "The page does not load" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Problems" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "The page does not load", expanded: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy note for your developer" })).toBeVisible();

  // One request for each landing page, only GET or HEAD, and the browser spoke only to this computer.
  expect(site.total).toBe(4);
  expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
  expect([...hosts].filter((h) => h !== "localhost" && h !== "127.0.0.1")).toEqual([]);
  expect(watch.problems).toEqual([]);
  expect(await watch.violations()).toEqual([]);
});

test("the address names the view: Ads for an ads run, and an unknown view opens it", async ({
  page,
}) => {
  const { link } = await start();
  await page.goto(link);
  await expect(page.getByRole("heading", { level: 1, name: "Ads" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toMatch(/^#\/[^/]+\/ads$/);
  await page.evaluate(() => {
    window.location.hash = window.location.hash.replace(/\/ads$/, "/overview");
  });
  await expect(page.getByRole("heading", { level: 1, name: "Ads" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toMatch(/\/ads$/);
});
