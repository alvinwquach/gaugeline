import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * noindex-header-missing (FF-03), through the built bin: Dockside Coffee is an invented pop-up cafe,
 * hidden from search until opening day. Its studio sends no X-Robots-Tag; the fixed copy does.
 */
const NOT_FOUND = "/gaugeline-not-found-3f9c2a71";
const MESSAGE = "A route the page metadata does not reach has no noindex header";
const dirs: string[] = [];
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function start(name: string): Promise<Fixture> {
  const site = await startFixture(name);
  sites.push(site);
  return site;
}
/** A working folder holding the named fixture's config files, as a person's project folder would. */
function folder(name: string, files: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-noindex-"));
  dirs.push(dir);
  for (const f of files) cpSync(join(SITES_DIR, name, f), join(dir, f));
  return dir;
}
const flags = (site: Fixture, more: string[] = []) => [
  site.origin,
  "--allow-private",
  "--no-open",
  ...more,
];
const paths = (site: Fixture) => site.requests.map((q) => `${q.method} ${q.path}`);

describe("noindex-header-missing: end to end", () => {
  it("with consent and a whole-site hidden section, the studio with no header is found", async () => {
    const site = await start("noindex-header-missing");
    const cwd = folder("noindex-header-missing", [
      "gaugeline.consent.json",
      "gaugeline.hidden.json",
    ]);
    const r = await runBin(flags(site), {}, { cwd });
    expect(r.stdout).toContain(MESSAGE);
    expect(r.stdout).toContain(
      "/studio answers 200 with no noindex in the X-Robots-Tag header or in the page",
    );
    expect(r.stdout).not.toContain("/api/health answers");
    expect(r.stderr).toContain("Probing checks are on (gaugeline.consent.json)");
  });

  it("asks exactly the routes the owner named and the made-up address, by GET, and nothing like /studio otherwise", async () => {
    const site = await start("noindex-header-missing");
    const cwd = folder("noindex-header-missing", [
      "gaugeline.consent.json",
      "gaugeline.hidden.json",
    ]);
    await runBin(flags(site), {}, { cwd });
    expect(paths(site)).toContain("GET /studio");
    expect(paths(site)).toContain("GET /api/health");
    expect(site.requests.filter((q) => q.path === "/studio")).toHaveLength(1);
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
    // Without the routes in the config, the studio is never asked.
    const other = await start("noindex-header-missing");
    const cwd2 = folder("noindex-header-missing", ["gaugeline.consent.json"]);
    writeFileSync(join(cwd2, "gaugeline.hidden.json"), '{ "hidden": [{ "match": "/*" }] }\n');
    const r = await runBin(flags(other), {}, { cwd: cwd2 });
    expect(paths(other)).not.toContain("GET /studio");
    expect(r.stdout).not.toContain(MESSAGE);
  });

  it("passes once the studio sends the header", async () => {
    const site = await start("noindex-header-set");
    const cwd = folder("noindex-header-set", ["gaugeline.consent.json", "gaugeline.hidden.json"]);
    const r = await runBin(flags(site), {}, { cwd });
    expect(r.stdout).not.toContain(MESSAGE);
    expect(r.stdout).toContain("\u2713 noindex-header-missing");
    expect(paths(site)).toContain("GET /studio");
  });

  it("without consent nothing is asked, and no route is named in the output", async () => {
    const site = await start("noindex-header-missing");
    const cwd = folder("noindex-header-missing", ["gaugeline.hidden.json"]);
    const r = await runBin(flags(site), {}, { cwd });
    expect(paths(site)).not.toContain("GET /studio");
    expect(paths(site)).not.toContain(`GET ${NOT_FOUND}`);
    expect(r.stdout).not.toContain(MESSAGE);
  });

  it("with consent and no hidden file the check does not apply and /studio is not asked", async () => {
    const site = await start("noindex-header-missing");
    const cwd = folder("noindex-header-missing", ["gaugeline.consent.json"]);
    const r = await runBin(flags(site), {}, { cwd });
    expect(paths(site)).not.toContain("GET /studio");
    expect(r.stdout).not.toContain(MESSAGE);
  });
});
