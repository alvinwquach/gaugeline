import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { startFixture, type Fixture } from "../packages/fixtures/src/index.ts";
import { buildNote } from "../packages/app/src/problems/note.ts";
import type { Finding, RunDetail } from "../packages/app/src/types.ts";

/** The built CLI (pnpm build runs before this). */
const BIN = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));

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

/** Check a fixture and open its Problems view. */
async function openProblems(page: Page, origin: string) {
  await page.goto(link);
  await page.getByLabel("Address to check").fill(origin);
  await page.getByLabel("Address to check").press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What looked right" })).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("link", { name: "Problems" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Problems" })).toBeVisible();
}

/** The run as the app's own server gives it: what the page was built from. */
async function currentRun(page: Page): Promise<RunDetail & { result: { findings: Finding[] } }> {
  const id = decodeURIComponent(new URL(page.url()).hash.split("/")[1] ?? "");
  return page.evaluate(
    async (runId) => (await fetch(`/api/runs/${encodeURIComponent(runId)}`)).json(),
    id,
  );
}

const toggles = (page: Page) => page.getByRole("main").locator("button.finding-toggle");

test("open a finding, copy the note, and the clipboard holds exactly what buildNote makes", async ({
  page,
  context,
}) => {
  const watch = await watchPage(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(link).origin,
  });
  const weight = await site("weight");
  await openProblems(page, weight.origin);

  const run = await currentRun(page);
  const wanted = run.result.findings.find((f) => f.checkId === "thin-html") as Finding;
  expect(wanted).toBeTruthy();
  await page.getByRole("button", { name: wanted.title }).click();
  // The plain-English text is there; the technical line is not until it is asked for.
  const detail = page.getByRole("main").locator(".detail");
  await expect(detail.getByRole("heading", { name: "Why it matters" })).toBeVisible();
  await expect(detail.getByRole("heading", { name: "How to fix it" })).toBeVisible();
  await expect(detail.locator(".tech")).toHaveCount(0);
  await detail.getByRole("button", { name: "Show technical detail" }).click();
  await expect(detail.locator(".tech")).toBeVisible();

  await detail.getByRole("button", { name: "Copy note for your developer" }).click();
  await expect(detail.locator(".copy-status")).toHaveText("Note copied to the clipboard.");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(buildNote(wanted, { url: run.url }));
  expect(clip).toContain(wanted.title);
  expect(clip).toContain(`Check: ${wanted.checkId}`);

  expect(await watch.violations()).toEqual([]);
  expect(watch.problems).toEqual([]);
});

test("without a clipboard the note is shown selected in a read-only box", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });
  const weight = await site("weight");
  await openProblems(page, weight.origin);
  const run = await currentRun(page);
  const first = run.result.findings.find((f) => f.severity === "high") as Finding;
  await page.getByRole("button", { name: first.title }).first().click();
  await page.getByRole("button", { name: "Copy note for your developer" }).click();
  const box = page.getByRole("textbox", { name: "Note for your developer" });
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute("readonly", "");
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(buildNote(first, { url: run.url }));
  const all = await box.evaluate(
    (el: HTMLTextAreaElement) => el.selectionStart === 0 && el.selectionEnd === el.value.length,
  );
  expect(all).toBe(true);
  await expect(page.locator(".copy-status")).toContainText("copy it by hand");
});

test("filter to Fix this first and one area: only matching findings remain, and a reload keeps the open one", async ({
  page,
}) => {
  const weight = await site("weight");
  await openProblems(page, weight.origin);
  const run = await currentRun(page);
  expect(run.result.findings).toHaveLength(6);
  await expect(toggles(page)).toHaveCount(6);

  await page.getByRole("button", { name: /^Fix this first/ }).click();
  await expect(page.getByRole("button", { name: /^Fix this first/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(toggles(page)).toHaveCount(2);
  await page.getByRole("button", { name: /^Search & sharing/ }).click();
  await expect(toggles(page)).toHaveCount(1);
  const thin = run.result.findings.find((f) => f.checkId === "thin-html") as Finding;
  await expect(toggles(page)).toHaveText(thin.title);
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Showing 1 of 6 problems");

  // Open it: the address names it, by its place in the result.
  await toggles(page).click();
  const index = run.result.findings.findIndex((f) => f.checkId === "thin-html");
  expect(new URL(page.url()).hash).toMatch(new RegExp(`^#/[^/]+/problems/${index}$`));
  await page.reload();
  // The filters start over; the open finding is still open.
  await expect(toggles(page)).toHaveCount(6);
  await expect(page.getByRole("button", { name: /^Fix this first/ })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const open = page.getByRole("main").locator('button.finding-toggle[aria-expanded="true"]');
  await expect(open).toHaveCount(1);
  await expect(open).toHaveText(thin.title);
  await expect(page.getByRole("main").locator(".detail")).toBeVisible();
});

test("keyboard only: filters toggle with Space, findings open with Enter, and axe finds nothing serious", async ({
  page,
}) => {
  const watch = await watchPage(page);
  const weight = await site("weight");
  await openProblems(page, weight.origin);

  const fixSoon = page.getByRole("button", { name: /^Fix soon/ });
  await fixSoon.focus();
  await page.keyboard.press("Space");
  await expect(fixSoon).toHaveAttribute("aria-pressed", "true");
  await expect(toggles(page)).toHaveCount(2);
  await page.keyboard.press("Enter");
  await expect(fixSoon).toHaveAttribute("aria-pressed", "false");
  await expect(toggles(page)).toHaveCount(6);

  await toggles(page).first().focus();
  await page.keyboard.press("Enter");
  await expect(toggles(page).first()).toHaveAttribute("aria-expanded", "true");
  // Focus is visible on the button that has it.
  const outline = await page.evaluate(
    () => getComputedStyle(document.activeElement as Element).outlineStyle,
  );
  expect(outline).not.toBe("none");
  // Tab from the finding reaches its buttons in order.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Show technical detail" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Copy note for your developer" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.locator(".copy-status")).not.toHaveText("");

  const axe = await new AxeBuilder({ page }).analyze();
  const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
  expect(await watch.violations()).toEqual([]);
  expect(watch.problems).toEqual([]);
});

test("a clean page says nothing needs fixing and links to the Overview", async ({ page }) => {
  const clean = await site("clean");
  await openProblems(page, clean.origin);
  await expect(page.getByText("Nothing needs fixing.")).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
});
