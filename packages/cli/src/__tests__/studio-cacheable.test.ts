import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * studio-response-cacheable (FF-19), through the built bin: Dockside Coffee is an invented pop-up cafe whose
 * editors work in a studio at /studio. The studio is cacheable; the fixed copy sends no-store.
 */
const MESSAGE = "The editor studio can be cached";
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
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-studio-"));
  dirs.push(dir);
  for (const f of files) cpSync(join(SITES_DIR, name, f), join(dir, f));
  return dir;
}
const flags = (site: Fixture) => [site.origin, "--allow-private", "--no-open"];
const paths = (site: Fixture) => site.requests.map((q) => `${q.method} ${q.path}`);
const CONFIG = ["gaugeline.consent.json", "gaugeline.studio.json"];

describe("studio-response-cacheable: end to end", () => {
  it("with consent and the studio named, a cacheable studio is found", async () => {
    const site = await start("studio-cacheable");
    const r = await runBin(flags(site), {}, { cwd: folder("studio-cacheable", CONFIG) });
    expect(r.stdout).toContain(MESSAGE);
    expect(r.stdout).toContain(
      "/studio answers 200 with a Cache-Control header that has no no-store",
    );
    expect(r.stdout).not.toContain("public, max-age=3600");
    expect(paths(site).filter((p) => p === "GET /studio")).toHaveLength(1);
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
  });

  it("passes once the studio sends no-store", async () => {
    const site = await start("studio-no-store");
    const r = await runBin(flags(site), {}, { cwd: folder("studio-no-store", CONFIG) });
    expect(r.stdout).not.toContain(MESSAGE);
    expect(r.stdout).toContain("✓ studio-response-cacheable");
    expect(paths(site)).toContain("GET /studio");
  });

  it("without consent nothing is asked and the studio is never named", async () => {
    const site = await start("studio-cacheable");
    const r = await runBin(
      flags(site),
      {},
      { cwd: folder("studio-cacheable", ["gaugeline.studio.json"]) },
    );
    expect(paths(site)).not.toContain("GET /studio");
    expect(r.stdout).not.toContain(MESSAGE);
  });

  it("with consent and no studio file the check does not apply and /studio is not asked", async () => {
    const site = await start("studio-cacheable");
    const r = await runBin(
      flags(site),
      {},
      { cwd: folder("studio-cacheable", ["gaugeline.consent.json"]) },
    );
    expect(paths(site)).not.toContain("GET /studio");
    expect(r.stdout).not.toContain(MESSAGE);
  });

  it("a studio file that is not valid is refused with the file named", async () => {
    const site = await start("studio-cacheable");
    const cwd = folder("studio-cacheable", ["gaugeline.consent.json"]);
    writeFileSync(join(cwd, "gaugeline.studio.json"), '{ "studioRoutes": ["studio"] }\n');
    const r = await runBin(flags(site), {}, { cwd });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("gaugeline.studio.json");
  });
});
