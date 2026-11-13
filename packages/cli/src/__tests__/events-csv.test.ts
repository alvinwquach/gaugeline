import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * The tracking spec as a CSV (NAV-06), through the built bin: the roastery of nav-events with its plan
 * in gaugeline.events.csv. Clicking needs a rendered read, so the three event checks are could-not-check.
 */
const dirs: string[] = [];
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
function folder(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-events-csv-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
const flags = (s: Fixture) => [s.origin, "--allow-private", "--no-open"];
const SPEC = join(SITES_DIR, "nav-events-csv", "gaugeline.events.csv");

describe("gaugeline.events.csv: end to end", () => {
  it("is read as the tracking plan: the three event checks are could-not-check, none passed", async () => {
    const site = await startFixture("nav-events-csv");
    sites.push(site);
    const dir = folder();
    cpSync(SPEC, join(dir, "gaugeline.events.csv"));
    const r = await runBin(flags(site), {}, { cwd: dir });
    expect(r.status).toBe(0);
    for (const id of ["events-distinct", "events-fire", "events-unlisted"])
      expect(r.stdout).toContain(
        `? ${id} could not be checked: clicking elements needs a rendered read`,
      );
    expect(r.stdout).not.toMatch(/✓ events-/);
  });

  it("both files in one folder stop the run with exit 2, naming both", async () => {
    const site = await startFixture("nav-events-csv");
    sites.push(site);
    const dir = folder({
      "gaugeline.events.json": '{ "events": [{ "region": "nav", "event": "e" }] }',
    });
    cpSync(SPEC, join(dir, "gaugeline.events.csv"));
    const r = await runBin(flags(site), {}, { cwd: dir });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain(
      "gaugeline.events.json and gaugeline.events.csv are both here",
    );
  });

  it("a row that cannot be read stops the run with exit 2, naming the file and the line", async () => {
    const site = await startFixture("nav-events-csv");
    sites.push(site);
    const dir = folder({
      "gaugeline.events.csv": "Region,Selector,Event\nnav,,menu_click\nsidebar,,x\n",
    });
    const r = await runBin(flags(site), {}, { cwd: dir });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain('gaugeline.events.csv line 3: the region "sidebar"');
  });

  it("reads the file and asks for nothing more: GET or HEAD only", async () => {
    const site = await startFixture("nav-events-csv");
    sites.push(site);
    const dir = folder();
    cpSync(SPEC, join(dir, "gaugeline.events.csv"));
    await runBin(flags(site), {}, { cwd: dir });
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
  });
});
