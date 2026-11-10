import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { runBin } from "./helpers/bin.js";

/**
 * The download route probe through the built bin: Tideline Coaching's invented members page links
 * to three download routes, and one of them hands a PDF to anyone. It is a probing check, so it
 * runs only with --owner-consent or a gaugeline.consent.json.
 */

const SITE = `${SITES_DIR}gated-downloads`;
const OPEN_LINE = "/api/download/7-day-plan -> 200 application/pdf";

const dirs: string[] = [];
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A working folder: the fixture's repository files (and its consent file when asked), never the fixture itself. */
function workdir(opts: { consent?: boolean; routes?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-gated-"));
  dirs.push(dir);
  if (opts.routes) cpSync(join(SITE, "app"), join(dir, "app"), { recursive: true });
  if (opts.consent)
    cpSync(join(SITE, "gaugeline.consent.json"), join(dir, "gaugeline.consent.json"));
  return dir;
}

async function start(): Promise<Fixture> {
  const site = await startFixture("gated-downloads");
  sites.push(site);
  return site;
}

/** What the probe asked: its requests are the ones that say they want no compression. */
const probed = (site: Fixture): string[] =>
  site.requests
    .filter((r) => r.headers["accept-encoding"] === "identity")
    .map((r) => `${r.method} ${r.path}`)
    .sort();

describe("gaugeline <address> --owner-consent: end to end", () => {
  it("--routes with the route files and --ci exits 1 on the open route", async () => {
    const site = await start();
    const cwd = workdir({ routes: true });
    const r = await runBin(
      [site.origin, "--owner-consent", "--routes", "app/api/**/route.ts", "--ci", "--no-open"],
      {},
      { cwd },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("A download meant for customers is handed to anyone");
    expect(r.stdout).toContain(OPEN_LINE);
    // The route that redirects to /login and the one that answers 401 pass; so does the 403 export.
    expect(r.stdout.match(/handed to anyone/g)).toHaveLength(1);
    expect(r.stderr).toContain("Probing checks are on (--owner-consent)");
    expect(r.stderr).toContain("permission to test");
    expect(probed(site)).toEqual([
      "GET /api/download/7-day-plan",
      "GET /api/download/class-notes",
      "GET /api/download/members-guide",
      "GET /api/export",
    ]);
  });

  it("a dynamic route file nothing links to is listed as not probed and never asked", async () => {
    const site = await start();
    const cwd = workdir({ routes: true });
    const r = await runBin(
      [site.origin, "--owner-consent", "--routes", "app/api/**/route.ts", "--no-open"],
      {},
      { cwd },
    );
    expect(r.stdout).toContain(
      "gated-download-open could not be checked: not asked: no link on the page gives an address for this dynamic route, and Gaugeline never guesses ids (/api/files/[...path])",
    );
    expect(site.hits.get("/api/files/anything")).toBeUndefined();
    // A route whose path does not say download, file, deliver or export is not asked at all.
    expect(site.hits.get("/api/stripe/webhook")).toBeUndefined();
  });

  it("the links on the page are enough, with no --routes", async () => {
    const site = await start();
    const r = await runBin(
      [site.origin, "--owner-consent", "--ci", "--no-open"],
      {},
      { cwd: workdir() },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(OPEN_LINE);
    expect(probed(site)).toEqual([
      "GET /api/download/7-day-plan",
      "GET /api/download/class-notes",
      "GET /api/download/members-guide",
    ]);
  });

  it("gaugeline.consent.json is the same as --owner-consent", async () => {
    const site = await start();
    const r = await runBin(
      [site.origin, "--routes", "app/api/**/route.ts", "--ci", "--no-open"],
      {},
      { cwd: workdir({ consent: true, routes: true }) },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(OPEN_LINE);
    expect(r.stderr).toContain("Probing checks are on (gaugeline.consent.json)");
  });

  it("--json lists the finding with no query string and no file content", async () => {
    const site = await start();
    const r = await runBin([site.origin, "--owner-consent", "--json"], {}, { cwd: workdir() });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout) as {
      findings: { checkId: string; url: string; evidence: string }[];
    };
    const found = json.findings.filter((f) => f.checkId === "gated-download-open");
    expect(found).toHaveLength(1);
    expect(found[0]?.url).toBe(`${site.origin}/api/download/7-day-plan`);
    expect(JSON.stringify(found)).not.toContain("invented file");
    expect(JSON.stringify(found)).not.toContain("%PDF");
  });
});

describe("without owner consent the check is off", () => {
  it("a default run asks no download route and exits 0", async () => {
    const site = await start();
    const r = await runBin([site.origin, "--ci", "--no-open"], {}, { cwd: workdir() });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("handed to anyone");
    expect(r.stdout).not.toContain("gated-download-open");
    expect(r.stderr).not.toContain("Probing checks are on");
    expect(probed(site)).toEqual([]);
  });

  it("--routes without consent is a usage error (exit 2) and nothing is requested", async () => {
    const site = await start();
    const r = await runBin(
      [site.origin, "--routes", "app/api/**/route.ts"],
      {},
      { cwd: workdir({ routes: true }) },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--routes");
    expect(r.stderr).toContain("--owner-consent");
    expect(site.total).toBe(0);
  });

  it("a consent file that is not valid is exit 2 and says which key", async () => {
    const site = await start();
    const cwd = workdir();
    writeFileSync(
      join(cwd, "gaugeline.consent.json"),
      JSON.stringify({ ownerConsent: { by: "" } }),
    );
    const r = await runBin([site.origin, "--no-open"], {}, { cwd });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("gaugeline.consent.json: ownerConsent.by");
    expect(site.total).toBe(0);
  });
});

describe("the flags", () => {
  it("--owner-consent and --routes (repeatable) are read by the page check", () => {
    expect(parseCliArgs(["tideline.example"])).toMatchObject({
      ownerConsent: false,
      routes: [],
    });
    expect(
      parseCliArgs([
        "tideline.example",
        "--owner-consent",
        "--routes",
        "app/api/**/route.ts",
        "--routes",
        "pages/api/**/*.ts",
      ]),
    ).toMatchObject({
      ownerConsent: true,
      routes: ["app/api/**/route.ts", "pages/api/**/*.ts"],
    });
  });

  it("other commands do not take them", () => {
    expect(parseCliArgs(["launch", "tideline.example", "--owner-consent"])).toMatchObject({
      kind: "error",
    });
  });
});
