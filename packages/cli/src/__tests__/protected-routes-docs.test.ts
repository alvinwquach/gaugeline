import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, SESSION_HELPERS, routeHiddenNotProtected } from "@gaugeline/core";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * docs/protected-routes.md shows `npx gaugeline check ./src --routes --base ... --owner-consent` and
 * what it prints. The docs runner (pnpm docs:examples) points every example at a fixture website and
 * this command reads a folder, so this test runs the page's own command in a copy of the invented
 * Fernbank Physio source folder (packages/fixtures/app-routes) against its invented site, and compares
 * the Output block with what the CLI prints. It also holds the page's numbers to the code's.
 */
const read = (url: string): string =>
  readFileSync(fileURLToPath(new URL(url, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const page = read("../../../../docs/protected-routes.md");
const options = read("../../../../docs/options.md");
const privacy = read("../../../../docs/privacy.md");
const APP = fileURLToPath(new URL("../../../fixtures/app-routes/", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("docs/protected-routes.md", () => {
  it("the example's command prints the Output block", async () => {
    const command = /^\$ npx gaugeline (check .*)$/m.exec(page)?.[1];
    const output = /```text title=Output\n([\s\S]*?)\n```/.exec(page)?.[1];
    expect(command).toBeDefined();
    expect(output).toBeDefined();
    const site = await startFixture("app-routes");
    try {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-routes-docs-")));
      dirs.push(cwd);
      cpSync(APP, join(cwd, "src"), { recursive: true });
      const argv = (command ?? "")
        .split(" ")
        .map((a) => (a.startsWith("https://") ? site.origin : a));
      const r = await runBin(argv, {}, { cwd });
      expect(r.status).toBe(0);
      expect(r.stdout.trimEnd()).toBe(output);
    } finally {
      await site.close();
    }
  });

  it("the table of answers matches what the fixture site sends", () => {
    const routes = JSON.parse(read("../../../fixtures/sites/app-routes/routes.json")) as Record<
      string,
      { status: number }
    >;
    expect(routes["/appointments"]?.status).toBe(302);
    expect(routes["/account/payments"]?.status).toBe(401);
    expect(routes["/account/invoices"]?.status).toBe(200);
    for (const row of ["302 to `/login`", "401: guarded", "200 with the page"])
      expect(page).toContain(row);
  });

  it("names the session helpers the code looks for, and the limits the code holds", () => {
    expect(SESSION_HELPERS).toEqual(["auth", "getServerSession", "cookies", "currentUser"]);
    expect(page).toContain("`auth()`, `getServerSession()`, `cookies()` or `currentUser()`");
    expect(page).toContain(`At most ${LIMITS.routeProbes} routes per run`);
    expect(page).toContain(`at most ${LIMITS.concurrency} requests at a time`);
    expect(page).toContain(`up to ${LIMITS.routeProbeBytes / 1024} KB`);
    expect(routeHiddenNotProtected.tech).toContain(`at most ${LIMITS.routeProbes}`);
    expect(privacy).toContain(`At most ${LIMITS.routeProbes} routes per run`);
  });

  it("says it is a probing check, run only on sites you own or have permission to test, and says what reading the folder does not do", () => {
    expect(page).toContain("Run it only on sites you own or have permission to test");
    expect(page).toContain("--owner-consent");
    expect(page).toContain("Reading your source files makes no request");
    expect(page).toContain("no option to send a session, a cookie or a token");
    expect(options).toContain("`route-hidden-not-protected`");
    expect(options).toContain("protected-routes.md");
    expect(privacy).toContain("### Signed-in routes (a probing check)");
    expect(page).toContain("privacy.md#signed-in-routes-a-probing-check");
    expect(privacy).toContain("Run it only on sites you own or have permission to");
  });

  it("is an invented clinic, not a real one", () => {
    expect(page).toContain("Fernbank Physio is an invented clinic");
    expect(page).not.toMatch(/\bhttps?:\/\/(?!fernbank-physio\.example)\S+/);
  });
});
