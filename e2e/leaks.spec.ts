import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Response } from "@playwright/test";
import { startApp, type RunningApp } from "../packages/app-server/src/index.ts";
import { PLANTED, startFixture, type Fixture } from "../packages/fixtures/src/index.ts";
import { createNetworkTransport, type Transport, type TransportResponse } from "@gaugeline/core";

const CLIENT_DIR = fileURLToPath(new URL("../packages/cli/dist/client", import.meta.url));
/** The one question Gaugeline asks a dataset: how many documents, and the names of their types. */
const SANITY_QUERY = '{"count": count(*), "types": array::unique(*[]._type)}';
const ELLIPSIS = String.fromCharCode(0x2026);
const mask = (key: string) => `${key.slice(0, 6)}${ELLIPSIS}${key.slice(-2)}`;

const SECRET = PLANTED["stripe-secret"] ?? "";
const RESTRICTED = PLANTED["stripe-restricted"] ?? "";
const PUBLISHABLE = PLANTED["stripe-publishable"] ?? "";

const TYPES = ["event", "menu", "page", "post", "venue", "wineList"];

/** What the dataset's address answers in a test. */
type Dataset = { status: 200; types: string[]; count: number } | { status: 401 };

let app: RunningApp | undefined;
let fixture: Fixture | undefined;
/** Every question the app's checks put to a Sanity address, as the transport saw it. */
let sanityAsked: URL[] = [];

const json = (status: number, body: unknown): TransportResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: Readable.from([Buffer.from(JSON.stringify(body))]),
});

/**
 * Start the app in this process, against the fixture and a stand-in for the Sanity API, so no
 * request leaves the machine. (A built `gaugeline open` cannot map an https host to a test server.)
 */
async function start(dataset: Dataset): Promise<{ site: Fixture; link: string }> {
  const site = await startFixture("leaks-access");
  fixture = site;
  sanityAsked = [];
  const local = createNetworkTransport({ hosts: site.hosts, allowPrivate: true });
  const transport: Transport = (url, req) => {
    if (!url.hostname.endsWith(".api.sanity.io")) return local(url, req);
    sanityAsked.push(url);
    return Promise.resolve(
      dataset.status === 200
        ? json(200, { result: { count: dataset.count, types: dataset.types } })
        : json(401, { error: "Unauthorized" }),
    );
  };
  app = await startApp({ clientDir: CLIENT_DIR, fetcher: { transport } });
  return { site, link: app.url };
}

test.afterEach(async () => {
  await app?.close();
  await fixture?.close();
  app = undefined;
  fixture = undefined;
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

/** Check the fixture and open the Leaks & access view. */
async function openView(page: Page, link: string, origin: string) {
  await page.goto(link);
  await page.getByLabel("Address to check").fill(origin);
  await page.getByLabel("Address to check").press("Enter");
  await expect(page.getByRole("heading", { name: "What looked right" })).toBeVisible({
    timeout: 20_000,
  });
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("link", { name: "Leaks & access" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Leaks & access" })).toBeVisible();
}

const panel = (page: Page, name: string) =>
  page.getByRole("heading", { level: 2, name }).locator("xpath=ancestor::section[1]");

async function noSeriousViolations(page: Page) {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
}

test("the leaked-key fixture: the file row names the key kind and shows only the masked value", async ({
  page,
}) => {
  const watch = await watchPage(page);
  // Every API answer the page receives, to look for a full key in.
  const bodies: string[] = [];
  page.on("response", (r: Response) => {
    if (new URL(r.url()).pathname.startsWith("/api/"))
      void r
        .text()
        .then((t) => bodies.push(t))
        .catch(() => undefined);
  });
  const { site, link } = await start({ status: 401 });
  await openView(page, link, site.origin);

  const table = panel(page, "JavaScript scanned for keys").getByRole("table");
  const row = (path: string) => table.getByRole("row").filter({ hasText: path });
  const app = row("/assets/app.js");
  await expect(app).toContainText("Stripe secret key");
  await expect(app).toContainText(mask(SECRET));
  await expect(app).toContainText(mask(RESTRICTED));
  await expect(app.getByRole("listitem")).toHaveCount(2);
  await expect(app.getByRole("link")).toHaveCount(2);
  await expect(row("/assets/vendor.js")).toContainText("Nothing found");
  await expect(row("/assets/old-booking.js")).toContainText("Not scanned");
  await expect(row("/assets/old-booking.js")).not.toContainText("Nothing found");
  await expect(panel(page, "JavaScript scanned for keys")).toContainText(
    "2 of up to 15 JavaScript files scanned",
  );

  // The full key is not in the page, in any text the page shows or in any answer the app sent.
  const text = await page.locator("body").innerText();
  const html = await page.content();
  for (const key of [SECRET, RESTRICTED, PUBLISHABLE]) {
    expect(text).not.toContain(key);
    expect(html).not.toContain(key);
  }
  await page.waitForTimeout(200);
  expect(bodies.length).toBeGreaterThan(0);
  for (const key of [SECRET, RESTRICTED, PUBLISHABLE])
    for (const b of bodies) expect(b).not.toContain(key);

  // Each key links to its own finding in Problems.
  const hrefs = await app
    .getByRole("link")
    .evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(new Set(hrefs).size).toBe(2);
  await app.getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Problems" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("A private key is in your site's JavaScript");

  expect(await watch.violations()).toEqual([]);
  expect(watch.problems).toEqual([]);
});

test("the public-dataset fixture: the type list matches, and only the count and type names were asked for", async ({
  page,
}) => {
  const watch = await watchPage(page);
  const { site, link } = await start({ status: 200, types: TYPES, count: 187 });
  await openView(page, link, site.origin);

  const dataset = panel(page, "Sanity dataset");
  await expect(dataset).toContainText("mo7h1an7");
  await expect(dataset).toContainText("production");
  await expect(dataset).toContainText("Public");
  const types = panel(page, "Types it holds");
  await expect(types).toContainText("187 documents in 6 types");
  await expect(types.getByRole("listitem")).toHaveText(TYPES);
  await expect(types).toContainText(
    "Only the number of documents and the names of their types. Never their contents.",
  );
  // The dataset finding is linked.
  await expect(dataset.getByRole("link", { name: /finding/ })).toHaveCount(1);

  // The only thing asked of the dataset is the count and the type names: no document contents.
  expect(sanityAsked).toHaveLength(1);
  for (const url of sanityAsked) {
    expect(url.pathname).toMatch(/\/data\/query\/production$/);
    expect(url.searchParams.get("query")).toBe(SANITY_QUERY);
  }
  // And nothing but GET and HEAD reached the checked site.
  expect([...(fixture?.methods.keys() ?? [])].sort()).toEqual(expect.arrayContaining(["GET"]));
  for (const m of fixture?.methods.keys() ?? []) expect(["GET", "HEAD"]).toContain(m);

  await noSeriousViolations(page);
  expect(await watch.violations()).toEqual([]);
  expect(watch.problems).toEqual([]);
});

test("a private dataset shows Private and no type panel", async ({ page }) => {
  const { site, link } = await start({ status: 401 });
  await openView(page, link, site.origin);
  await expect(panel(page, "Sanity dataset")).toContainText("Private");
  await expect(page.getByRole("heading", { level: 2, name: "Types it holds" })).toHaveCount(0);
});

test("staging copies: the staging address answers publicly, and the preview link is listed as not requested", async ({
  page,
}) => {
  const { site, link } = await start({ status: 401 });
  await openView(page, link, site.origin);
  const table = panel(page, "Staging copies").getByRole("table");
  const staging = table.getByRole("row").filter({ hasText: "staging.moth-lantern.test" });
  await expect(staging).toContainText("Yes. Answers publicly");
  await expect(staging.getByRole("link")).toHaveCount(1);
  const preview = table
    .getByRole("row")
    .filter({ hasText: "moth-lantern-git-menu-studio.vercel.app" });
  await expect(preview).toContainText("Gaugeline did not request it");
  // The fixture saw one request for the staging host, and the preview address was never requested.
  const hosts = (fixture?.requests ?? []).map((r) => r.host);
  // (a mapped host connects to its own port, so the Host header is that address)
  expect(hosts.filter((h) => h === site.hosts["staging.moth-lantern.test"])).toHaveLength(1);
  expect(hosts.some((h) => h.includes("vercel.app"))).toBe(false);
});

test("a dataset with 200 types scrolls inside its panel, the page does not grow sideways, and markup is text", async ({
  page,
}) => {
  const types = [
    '<img src=x onerror="document.title=1">',
    `${"veryLongTypeName".repeat(12)}`,
    ...Array.from({ length: 198 }, (_, i) => `type${String(i).padStart(3, "0")}`),
  ];
  await page.setViewportSize({ width: 390, height: 800 });
  const { site, link } = await start({ status: 200, types, count: 9000 });
  await openView(page, link, site.origin);
  const list = panel(page, "Types it holds").getByRole("list");
  await expect(list.getByRole("listitem")).toHaveCount(200);
  const scroll = await list.evaluate((el) => ({
    inner: el.scrollHeight > el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(scroll).toEqual({ inner: true, overflowY: "auto" });
  // Nothing in the panel is wider than the panel, on a phone and on a laptop.
  const section = panel(page, "Types it holds");
  const fits = () =>
    section.evaluate(
      (el) =>
        el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= window.innerWidth,
    );
  expect(await fits()).toBe(true);
  await page.setViewportSize({ width: 800, height: 800 });
  expect(await fits()).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
  ).toBe(false);
  // Markup in a type name is text: no image was made, and the title was not touched.
  await expect(list.locator("img")).toHaveCount(0);
  await expect(list.getByRole("listitem").first()).toHaveText(types[0] ?? "");
  expect(await page.title()).not.toBe("1");
});

test("promise: opening the view asks for nothing but the app's own API, and asks the site and the dataset for nothing more", async ({
  page,
}) => {
  const { site, link } = await start({ status: 200, types: TYPES, count: 187 });
  await page.goto(link);
  await page.getByLabel("Address to check").fill(site.origin);
  await page.getByLabel("Address to check").press("Enter");
  await expect(page.getByRole("heading", { name: "What looked right" })).toBeVisible({
    timeout: 20_000,
  });
  const sitesBefore = fixture?.total ?? 0;
  const sanityBefore = sanityAsked.length;
  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("link", { name: "Leaks & access" })
    .click();
  await expect(panel(page, "Types it holds")).toBeVisible();
  await page.waitForTimeout(300);
  const appOrigin = new URL(link).origin;
  expect(requested.filter((u) => new URL(u).origin !== appOrigin)).toEqual([]);
  expect(requested.filter((u) => !new URL(u).pathname.startsWith("/api/"))).toEqual([]);
  expect(fixture?.total ?? 0).toBe(sitesBefore);
  expect(sanityAsked).toHaveLength(sanityBefore);
});
