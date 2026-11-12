import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * Error pages that answer 200 (XF-03), through the built bin: Harbour Lane Books is an invented
 * bookshop whose events page is the Next.js error page and whose gift cards page says "Page not
 * found", both served with 200, and whose host answers 200 for an address that does not exist.
 */

const NOT_FOUND = "/gaugeline-not-found-3f9c2a71";
const dirs: string[] = [];
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function start(): Promise<Fixture> {
  const site = await startFixture("error-pages");
  sites.push(site);
  return site;
}

function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-errpages-"));
  dirs.push(dir);
  return dir;
}

describe("error pages that answer 200: end to end", () => {
  it("without consent the two error pages are found and the made-up address is never asked", async () => {
    const site = await start();
    const r = await runBin([site.origin, "--allow-private", "--no-open"], {}, { cwd: emptyDir() });
    expect(r.stdout).toContain("A page that is an error says everything is fine");
    expect(r.stdout).toContain(
      `${site.origin}/events/readings answers 200 but shows the Next.js error page`,
    );
    expect(r.stdout).toContain(`${site.origin}/shop/gift-cards answers 200 but shows a page title`);
    expect(r.stdout).not.toContain("Pages that do not exist answer 200");
    expect(site.requests.map((q) => q.path)).not.toContain(NOT_FOUND);
    expect(r.stdout).not.toContain("/books/tide-and-thistle answers");
  });

  it("with --owner-consent exactly one GET asks for the made-up address, and it is a finding", async () => {
    const site = await start();
    const r = await runBin(
      [site.origin, "--allow-private", "--no-open", "--owner-consent"],
      {},
      { cwd: emptyDir() },
    );
    expect(r.stdout).toContain(`${NOT_FOUND} answers 200, not 404`);
    expect(site.requests.filter((q) => q.path === NOT_FOUND).map((q) => q.method)).toEqual(["GET"]);
    expect(r.stderr).toContain("Probing checks are on (--owner-consent)");
  });

  it("a gaugeline.consent.json in the folder is the same consent", async () => {
    const site = await start();
    const cwd = emptyDir();
    cpSync(
      join(SITES_DIR, "error-pages", "gaugeline.consent.json"),
      join(cwd, "gaugeline.consent.json"),
    );
    const r = await runBin([site.origin, "--allow-private", "--no-open"], {}, { cwd });
    expect(r.stdout).toContain(`${NOT_FOUND} answers 200, not 404`);
    expect(r.stderr).toContain("Probing checks are on (gaugeline.consent.json)");
  });

  it("the page's own words never reach the report", async () => {
    const site = await start();
    const r = await runBin(
      [site.origin, "--allow-private", "--no-open", "--json"],
      {},
      { cwd: emptyDir() },
    );
    const json = JSON.parse(r.stdout) as { findings: { checkId: string; evidence: string }[] };
    const mine = json.findings.filter((f) => f.checkId === "error-shell-200");
    expect(mine).toHaveLength(2);
    for (const f of mine) {
      expect(f.evidence).not.toMatch(/Reload to try again|Sorry, we could not/);
    }
  });
});
