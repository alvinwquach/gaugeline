import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultSchema } from "@gaugeline/core";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { createPlaywrightRenderer, findBrowser } from "@gaugeline/renderer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT, main } from "../main.js";

/**
 * `gaugeline <address> --renderer playwright` with a tracking plan, end to end through main(): the plan's links
 * are clicked in a real browser and the click checks report on what the page sent. Runs only where a browser
 * is installed; where it will not start, it is skipped, saying why.
 */
const found = findBrowser({ env: process.env, exists: existsSync, platform: process.platform });
let driver = true;
try {
  await import("playwright-core");
} catch {
  driver = false;
}

describe.skipIf(!driver || !found.ok)("--renderer playwright with a tracking plan", () => {
  let site: Fixture;
  let dir: string;
  beforeAll(async () => {
    site = await startFixture("renderer-clicks");
    dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-clicks-")));
    copyFileSync(
      join(SITES_DIR, "renderer-clicks", "gaugeline.events.json"),
      join(dir, "gaugeline.events.json"),
    );
  });
  afterAll(async () => {
    await site?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function run(args: string[]) {
    let out = "";
    let err = "";
    const code = await main(
      [site.origin, "--allow-private", "--no-open", "--json", ...args],
      {
        stdout: { write: (s: string) => ((out += s), true) },
        stderr: { write: (s: string) => ((err += s), true) },
        env: {},
      },
      {
        cwd: dir,
        renderer: ({ transport }) =>
          createPlaywrightRenderer({
            transport,
            env: process.env,
            chromiumSandbox: process.getuid?.() !== 0,
            limits: { pages: 20 },
          }),
      },
    );
    return { code, out, err };
  }
  const eventsOf = (out: string) => {
    const result = resultSchema.parse(JSON.parse(out));
    return {
      findings: result.findings.filter((f) => f.checkId.startsWith("events-")),
      unchecked: result.couldNotCheck.filter((c) => c.id.startsWith("events-")),
    };
  };

  it("without the flag nothing is clicked: the click checks are could not check", async () => {
    const { code, out } = await run([]);
    expect(code).toBe(EXIT.ok);
    const { findings, unchecked } = eventsOf(out);
    // The one thing that needs no click: a tabindex in the page as sent.
    expect(findings.map((f) => f.checkId)).toEqual(["events-tab-order"]);
    expect(findings[0]?.evidence).toMatch(/has tabindex="1"/);
    expect(unchecked.map((c) => c.id).sort()).toEqual([
      "events-distinct",
      "events-fire",
      "events-parity",
      "events-tab-order",
      "events-unlisted",
    ]);
    expect(unchecked[0]?.reason).toMatch(/needs a rendered read/);
  }, 120_000);

  it("with the flag, clicks the plan's links in the browser and reports the one that sent nothing", async (ctx) => {
    const { code, out, err } = await run(["--renderer", "playwright"]);
    if (/could not start/.test(err)) return ctx.skip("the browser does not start here");
    expect(code).toBe(EXIT.ok);
    const { findings, unchecked } = eventsOf(out);
    expect(findings.map((f) => [f.checkId, f.evidence])).toEqual([
      ["events-fire", `"Menu" (/menu.html) sent no menu_click event`],
      [
        "events-parity",
        '"Jobs" (/jobs.html) reports differently at 375 px than at 1280 px: sent menu_click at 1280 px and nothing at 375 px',
      ],
      [
        "events-tab-order",
        `1 of the plan's links takes focus in a different place than it comes in the page: "Menu" (/menu.html) is reached 1st but comes 2nd`,
      ],
      [
        "events-tab-order",
        `1 of the plan's links has a positive tabindex, which puts it ahead of every link without one: "Menu" (/menu.html) has tabindex="1"`,
      ],
    ]);
    // The button, the link in a form and the link to another site were left unclicked, and said so: for each
    // check that reads them, never a pass.
    expect(unchecked.map((c) => c.id).sort()).toEqual([
      "events-fire",
      "events-parity",
      "events-tab-order",
    ]);
    expect(unchecked.find((c) => c.id === "events-fire")?.reason).toMatch(
      /^3 of the plan's links could not be observed/,
    );
    // The site saw clicks as page loads, and only GETs.
    expect(site.hits.get("/shop.html")).toBeGreaterThanOrEqual(1);
    expect([...site.methods.keys()].sort()).toEqual(["GET", "HEAD"]);
  }, 240_000);
});
