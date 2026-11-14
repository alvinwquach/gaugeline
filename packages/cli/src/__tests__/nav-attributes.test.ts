import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * tracking-attributes-missing (NAV-05), through the built bin: Spoke and Chain is an invented
 * bicycle repair shop. Its plan lists attributes only; two nav links and one button lack them.
 */
const dirs: string[] = [];
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
function folder(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-attributes-"));
  dirs.push(dir);
  if (config === undefined)
    cpSync(
      join(SITES_DIR, "nav-attributes", "gaugeline.events.json"),
      join(dir, "gaugeline.events.json"),
    );
  else writeFileSync(join(dir, "gaugeline.events.json"), config);
  return dir;
}
const flags = (s: Fixture) => [s.origin, "--allow-private", "--no-open"];

describe("tracking-attributes-missing: end to end", () => {
  it("names the nav links with no data-track and the button with no data-location", async () => {
    const site = await startFixture("nav-attributes");
    sites.push(site);
    const r = await runBin(flags(site), {}, { cwd: folder() });
    expect(r.stdout).toContain(
      'nav links: 2 of 4 have no data-track: "Hire" (/hire), "Contact" (/contact)',
    );
    expect(r.stdout).toContain(
      'a.book-now: 1 of 2 have no data-location: "Book a hire bike" (/hire)',
    );
    expect(r.stdout).not.toContain("could not be checked: clicking elements");
  });

  it("asks nothing for it: the run makes no request beyond the ones it always makes, and only GET or HEAD", async () => {
    const site = await startFixture("nav-attributes");
    sites.push(site);
    await runBin(flags(site), {}, { cwd: folder() });
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
  });

  it("an attribute rule with both a selector and a region stops the run with exit 2, naming it", async () => {
    const site = await startFixture("nav-attributes");
    sites.push(site);
    const bad =
      '{ "attributes": [{ "region": "nav", "selector": "a", "require": ["data-track"] }] }';
    const r = await runBin(flags(site), {}, { cwd: folder(bad) });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain("selector or a region");
  });

  it("a plan with neither events nor attributes stops the run with exit 2", async () => {
    const site = await startFixture("nav-attributes");
    sites.push(site);
    const r = await runBin(flags(site), {}, { cwd: folder('{ "events": [] }') });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain("at least one rule");
  });
});
