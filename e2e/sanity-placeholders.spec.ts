import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** The built CLI (pnpm build runs before this). */
const BIN = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));

/** What the placeholders say under every one of the three. */
const NOTE = "Needs your Sanity login. Coming in version 0.2.";
const OFF = ["Page cost", "Automatic messages", "Content"] as const;
const ON = ["Overview", "Problems", "Pages checked", "Search data", "Leaks & access"] as const;

let child: ChildProcess | undefined;

/** `gaugeline open --demo --no-open`, resolved with the one-time link it prints. */
async function openDemo(): Promise<string> {
  const c = spawn(process.execPath, [BIN, "open", "--demo", "--no-open"], {
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
});

/** Every console problem, page error and policy violation, from before the page's first script. */
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

const nav = (page: Page) => page.getByRole("navigation", { name: "Views" });

/** The demo, open on its newest run, resolved with that run's id. */
async function start(page: Page): Promise<string> {
  await page.goto(await openDemo());
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toMatch(/^#\/[^/]+\/overview$/);
  const hash = await page.evaluate(() => window.location.hash);
  return decodeURIComponent(hash.split("/")[1] ?? "");
}

async function noSeriousViolations(page: Page) {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
}

test("the navigation lists the five views, then Page cost, Automatic messages and Content switched off, in the demo", async ({
  page,
}) => {
  const watch = await watchPage(page);
  await start(page);
  await expect(nav(page).getByRole("link")).toHaveText([...ON]);
  const items = nav(page).getByRole("listitem");
  await expect(items).toHaveText([...ON, ...OFF.map((l) => `${l}${NOTE}`)]);
  for (const label of OFF) {
    const button = nav(page).getByRole("button", { name: label, exact: true });
    await expect(button).toHaveAttribute("aria-disabled", "true");
    // Not the disabled attribute, which would take it out of the Tab order.
    expect(await button.evaluate((el) => el.hasAttribute("disabled"))).toBe(false);
    expect(await button.getAttribute("title")).toBeNull();
    // The note is its description, so it is heard once.
    expect(
      await button.evaluate((el) => {
        const id = el.getAttribute("aria-describedby") ?? "";
        return document.getElementById(id)?.textContent;
      }),
    ).toBe(NOTE);
  }
  expect(watch.problems).toEqual([]);
  expect(await watch.violations()).toEqual([]);
});

test("a disabled item takes focus and does nothing when it is clicked or Enter is pressed", async ({
  page,
}) => {
  const runId = await start(page);
  const button = nav(page).getByRole("button", { name: "Page cost", exact: true });
  // Playwright treats aria-disabled as not enabled, so the click is forced: a person can make it.
  await button.click({ force: true });
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  // Nothing moved: the address and the view are what they were.
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/${runId}/overview`);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

  // Tab from the last link reaches the three in order.
  await nav(page).getByRole("link", { name: "Leaks & access" }).focus();
  for (const label of OFF) {
    await page.keyboard.press("Tab");
    await expect(nav(page).getByRole("button", { name: label, exact: true })).toBeFocused();
  }
});

test("going to #/<run>/pageCost shows the ComingSoon panel and no request is made", async ({
  page,
}) => {
  const watch = await watchPage(page);
  const runId = await start(page);
  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));

  for (const [id, label, sentence] of [
    ["pageCost", "Page cost", "what each page asks Sanity for, compared with what it shows"],
    ["automaticMessages", "Automatic messages", "things Sanity does by itself when you publish"],
    ["content", "Content", "with the pages each item appears on"],
  ] as const) {
    await page.evaluate((h) => (window.location.hash = h), `#/${runId}/${id}`);
    await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
    await expect(page.getByRole("main")).toContainText(NOTE);
    await expect(page.getByRole("main")).toContainText(sentence);
    await expect(page.getByRole("main").locator("table")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/${runId}/${id}`);
  }
  // A moment for anything that would have been sent in the background.
  await page.waitForTimeout(300);
  expect(requested).toEqual([]);
  await noSeriousViolations(page);
  expect(watch.problems).toEqual([]);
  expect(await watch.violations()).toEqual([]);
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing serious with the disabled items present, ${scheme} colours`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await start(page);
    await expect(nav(page).getByRole("button")).toHaveCount(3);
    await noSeriousViolations(page);
  });
}

test("at 320 px the notes wrap under their labels and the navigation does not scroll sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await start(page);
  await expect(nav(page).getByRole("button")).toHaveCount(3);
  const box = await nav(page).evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    right: el.getBoundingClientRect().right,
  }));
  expect(box.scroll).toBeLessThanOrEqual(box.client);
  expect(box.right).toBeLessThanOrEqual(320);
  for (const label of OFF) {
    const item = nav(page).getByRole("listitem").filter({ hasText: label });
    const button = await item.getByRole("button").boundingBox();
    const note = await item.getByText(NOTE).boundingBox();
    expect(button && note && note.y >= button.y + button.height - 1).toBe(true);
    expect(note && note.x + note.width <= 320).toBe(true);
  }
});
