import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * Open image optimizers (XF-04, ADR-0007), through the built bin: Cedar and Crumb Bakery is an
 * invented bakery whose Next.js image address fetches any picture and whose next.config.js allows
 * every host. The settings file is read with or without consent; the one probe GET is sent only with
 * consent and only to the address the owner chose.
 */

const dirs: string[] = [];
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function start(): Promise<Fixture> {
  const site = await startFixture("image-optimizer");
  sites.push(site);
  return site;
}

/** A working folder holding the named files of the fixture. */
function folder(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-imgopt-"));
  dirs.push(dir);
  for (const f of files) cpSync(join(SITES_DIR, "image-optimizer", f), join(dir, f));
  return dir;
}

/** The GETs to the optimizer: the page's own image checks only HEAD its /_next/image addresses, so a GET is the probe. */
const optimizerGets = (site: Fixture) =>
  site.requests.filter((q) => q.path.startsWith("/_next/image") && q.method === "GET");

describe("open image optimizers: end to end", () => {
  it("without consent the settings file is read, nothing is sent to the optimizer", async () => {
    const site = await start();
    const cwd = folder("gaugeline.images.json", "next.config.js");
    const r = await runBin([site.origin, "--allow-private", "--no-open"], {}, { cwd });
    expect(r.stdout).toContain("Your image settings let the image address fetch from any website");
    expect(r.stdout).toContain(
      'next.config.js line 4: hostname: "**" lets the image address fetch from any host',
    );
    expect(r.stdout).not.toContain("fetched a picture from a website you did not list");
    expect(optimizerGets(site)).toHaveLength(0);
  });

  it("a site with an optimizer and no settings file is could not check, and nothing is sent", async () => {
    const site = await start();
    const r = await runBin([site.origin, "--allow-private", "--no-open"], {}, { cwd: folder() });
    expect(r.stdout).toContain("image-optimizer-allowlist-wide");
    expect(r.stdout).toContain("not visible from the page");
    expect(optimizerGets(site)).toHaveLength(0);
  });

  it("with consent and the owner's address exactly one GET is sent and it is a finding", async () => {
    const site = await start();
    const cwd = folder("gaugeline.images.json", "next.config.js");
    const r = await runBin(
      [site.origin, "--allow-private", "--no-open", "--owner-consent"],
      {},
      { cwd },
    );
    expect(r.stdout).toContain(
      "Your image address fetched a picture from a website you did not list",
    );
    expect(r.stdout).toContain("test-pictures.example/gaugeline-probe.png");
    const gets = optimizerGets(site);
    expect(gets.map((q) => q.method)).toEqual(["GET"]);
    expect(r.stderr).toContain("Probing checks are on (--owner-consent)");
    expect(r.stderr).toContain("image-optimizer-open");
  });

  it("with consent and no probe address nothing is sent and the run says so", async () => {
    const site = await start();
    const cwd = folder();
    const r = await runBin(
      [site.origin, "--allow-private", "--no-open", "--owner-consent"],
      {},
      { cwd },
    );
    expect(optimizerGets(site)).toHaveLength(0);
    expect(r.stdout).toContain("imageOptimizerProbeUrl");
  });

  it("the probe address's query string never reaches the report or the JSON", async () => {
    const site = await start();
    const cwd = folder("next.config.js");
    writeFileSync(
      join(cwd, "gaugeline.images.json"),
      JSON.stringify({
        imageOptimizerProbeUrl: "https://test-pictures.example/p.png?key=sk_not_real_123",
      }),
    );
    const r = await runBin(
      [site.origin, "--allow-private", "--no-open", "--owner-consent", "--json"],
      {},
      { cwd },
    );
    expect(r.stdout).toContain("image-optimizer-open");
    expect(r.stdout + r.stderr).not.toContain("sk_not_real_123");
  });

  it("a probe address on a private address is refused and nothing is sent", async () => {
    const site = await start();
    const cwd = folder();
    writeFileSync(
      join(cwd, "gaugeline.images.json"),
      JSON.stringify({ imageOptimizerProbeUrl: "https://169.254.169.254/latest/meta-data/" }),
    );
    const r = await runBin(
      [site.origin, "--allow-private", "--no-open", "--owner-consent"],
      {},
      { cwd },
    );
    expect(optimizerGets(site)).toHaveLength(0);
    expect(r.stdout).toContain("IP address");
  });

  it("a settings file that does not exist is a clear error", async () => {
    const site = await start();
    const cwd = folder();
    writeFileSync(
      join(cwd, "gaugeline.images.json"),
      JSON.stringify({ settingsFiles: ["nope.config.js"] }),
    );
    const r = await runBin([site.origin, "--allow-private", "--no-open"], {}, { cwd });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("nope.config.js");
  });

  it("the probe address in the file is ignored without consent", async () => {
    const site = await start();
    const cwd = folder("gaugeline.images.json", "next.config.js");
    await runBin([site.origin, "--allow-private", "--no-open"], {}, { cwd });
    expect(site.requests.map((q) => q.path).join(" ")).not.toContain("test-pictures");
  });
});
