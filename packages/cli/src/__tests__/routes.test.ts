import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resultSchema } from "@gaugeline/core";
import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { HELP } from "../help.js";
import { EXIT, main } from "../main.js";
import { runBin } from "./helpers/bin.js";

/**
 * gaugeline check <folder> --routes --base <address> through the built bin: Fernbank Physio's
 * invented source tree (packages/fixtures/app-routes) against its invented running site
 * (packages/fixtures/sites/app-routes). One of its three signed-in routes hands its page to anyone.
 * It is a probing check, so it runs only with --owner-consent or a gaugeline.consent.json.
 */

const APP = fileURLToPath(new URL("../../../fixtures/app-routes/", import.meta.url));
const FINDING = "/account/invoices is handed over with no session";

const dirs: string[] = [];
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function start(): Promise<Fixture> {
  const site = await startFixture("app-routes");
  sites.push(site);
  return site;
}

/** A working folder, with a repository of page files when given. */
function workdir(files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-routes-cli-")));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const target = join(dir, ...name.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return dir;
}

describe("gaugeline check <folder> --routes --base: end to end", () => {
  it("prints the finding, naming the file, and with --ci exits 1", async () => {
    const site = await start();
    const r = await runBin(
      ["check", APP, "--routes", "--base", site.origin, "--owner-consent", "--ci", "--no-open"],
      {},
      { cwd: workdir() },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`\u2717 ${FINDING}`);
    expect(r.stdout).toContain("answered 200 with 127 bytes to a request with no session");
    expect(r.stdout).toContain("(the page calls auth())");
    expect(r.stdout).toContain("File: ");
    expect(r.stdout).toContain(
      join(APP, "app", "account", "invoices", "page.tsx").split("\\").join("/"),
    );
    // One finding: the redirect and the 401 pass, and every answer is shown.
    expect(r.stdout.match(/is handed over with no session/g)).toHaveLength(1);
    expect(r.stdout).toContain("/appointments");
    expect(r.stdout).toContain("redirected to /login (302)");
    expect(r.stdout).toContain("refused (401)");
    expect(r.stdout).toContain("handed over (200), 127 bytes");
    expect(r.stdout).toContain("1 to look at, 1 to fix first.");
    expect(r.stderr).toContain("Probing checks are on (--owner-consent)");
    expect(r.stderr).toContain("permission to test");
  });

  it("without --ci the same run exits 0, and the word check is optional", async () => {
    const site = await start();
    const r = await runBin(
      [APP, "--routes", "--base", site.origin, "--owner-consent"],
      {},
      { cwd: workdir() },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(FINDING);
  });

  it("asks only the three signed-in routes, with GET, no cookie, no Authorization and no Referer", async () => {
    const site = await start();
    await runBin(
      ["check", APP, "--routes", "--base", site.origin, "--owner-consent"],
      {},
      { cwd: workdir() },
    );
    expect([...site.hits.keys()].sort()).toEqual([
      "/account/invoices",
      "/account/payments",
      "/appointments",
    ]);
    expect([...site.methods.keys()]).toEqual(["GET"]);
    for (const r of site.requests) {
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
      expect(r.headers.referer).toBeUndefined();
    }
    expect(site.maxConcurrent).toBeLessThanOrEqual(5);
  });

  it("gaugeline.consent.json is the same as --owner-consent", async () => {
    const site = await start();
    const cwd = workdir();
    cpSync(join(APP, "gaugeline.consent.json"), join(cwd, "gaugeline.consent.json"));
    const r = await runBin(["check", APP, "--routes", "--base", site.origin, "--ci"], {}, { cwd });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Probing checks are on (gaugeline.consent.json)");
  });

  it("without consent it is exit 2 and nothing is asked", async () => {
    const site = await start();
    const r = await runBin(
      ["check", APP, "--routes", "--base", site.origin],
      {},
      { cwd: workdir() },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("probing check");
    expect(r.stderr).toContain("--owner-consent");
    expect(site.total).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("--json is the schema 2 result and nothing else", async () => {
    const site = await start();
    const r = await runBin(
      ["check", APP, "--routes", "--base", site.origin, "--owner-consent", "--json"],
      {},
      { cwd: workdir() },
    );
    expect(r.status).toBe(0);
    const result = resultSchema.parse(JSON.parse(r.stdout));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      checkId: "route-hidden-not-protected",
      severity: "high",
      url: `${site.origin}/account/invoices`,
    });
  });

  it("--quiet leaves out the notice on stderr", async () => {
    const site = await start();
    const r = await runBin(
      ["check", APP, "--routes", "--base", site.origin, "--owner-consent", "--quiet"],
      {},
      { cwd: workdir() },
    );
    expect(r.stderr).toBe("");
  });
});

describe("gaugeline check --routes: usage and edge cases", () => {
  it("--routes without --base is a usage message and exit 2", async () => {
    const r = await runBin(["check", APP, "--routes", "--owner-consent"], {}, { cwd: workdir() });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("needs the address of the running site");
    expect(r.stderr).toContain("--base https://example.com");
    expect(r.stdout).toBe("");
  });

  it("a folder that does not exist, a file, and a folder with no app directory are exit 2", async () => {
    const site = await start();
    const cwd = workdir({ "lib/util.ts": "export {};\n" });
    const base = ["--routes", "--base", site.origin, "--owner-consent"];
    const missing = await runBin(["check", "nowhere", ...base], {}, { cwd });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("The folder nowhere does not exist");
    const file = await runBin(["check", "lib/util.ts", ...base], {}, { cwd });
    expect(file.status).toBe(2);
    expect(file.stderr).toContain("is a file, not a folder");
    const none = await runBin(["check", "lib", ...base], {}, { cwd });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("No Next.js app folder found in lib");
    expect(site.total).toBe(0);
  });

  it("an address with a password in it is exit 2 and nothing is asked", async () => {
    const site = await start();
    const r = await runBin(
      [
        "check",
        APP,
        "--routes",
        "--owner-consent",
        "--allow-private",
        "--base",
        site.origin.replace("http://", "http://dana:pw@"),
      ],
      {},
      { cwd: workdir() },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("must not carry a user name or a password");
    expect(site.total).toBe(0);
  });

  it("a private address without --allow-private is exit 2 and nothing is asked", async () => {
    const site = await start();
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ["check", APP, "--routes", "--owner-consent", "--base", site.origin],
      { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env: {} },
      { cwd: workdir() },
    );
    expect(code).toBe(EXIT.couldNotRun);
    expect(site.total).toBe(0);
    expect(out.join("")).toBe("");
  });

  it("45 guarded routes: 30 asked, 15 listed as not probed", async () => {
    const site = await start();
    const files: Record<string, string> = {};
    for (let i = 0; i < 45; i++)
      files[`src/app/r${String(i).padStart(2, "0")}/page.tsx`] =
        'import { auth } from "@/auth";\nexport default async function P() { await auth(); return null; }\n';
    const cwd = workdir(files);
    const r = await runBin(
      ["check", "src", "--routes", "--base", site.origin, "--owner-consent"],
      {},
      { cwd },
    );
    expect(r.status).toBe(0);
    expect(site.total).toBe(30);
    expect(r.stdout).toContain("Asked 30 routes once each");
    expect(r.stdout.match(/not probed: more than 30 routes expect a session/g)).not.toBeNull();
    expect(r.stdout).toContain("/r30");
    expect(r.stdout).toContain("and 12 more");
    expect(r.stdout).not.toContain("handed over with no session");
  });

  it("a dynamic guarded route is listed as not probed: needs a real id", async () => {
    const site = await start();
    const cwd = workdir({
      "app/orders/[id]/page.tsx":
        'import { auth } from "@/auth";\nexport default async function P() { await auth(); return null; }\n',
    });
    const r = await runBin(
      ["check", ".", "--routes", "--base", site.origin, "--owner-consent"],
      {},
      { cwd },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("not probed: needs a real id (/orders/[id])");
    expect(site.total).toBe(0);
  });

  it("files read as they would be typed from where the command ran", async () => {
    const site = await start();
    const cwd = workdir();
    cpSync(join(APP, "app"), join(cwd, "site", "app"), { recursive: true });
    const r = await runBin(
      ["check", "./site/", "--routes", "--base", site.origin, "--owner-consent"],
      {},
      { cwd },
    );
    expect(r.stdout).toContain("File: ./site/app/account/invoices/page.tsx.");
    expect(r.stdout).toContain("under ./site/app:");
  });
});

describe("gaugeline check --routes: the command line", () => {
  it("--routes with no glob, before another flag or at the end, is the route tree", () => {
    const a = parseCliArgs([
      "check",
      "./src",
      "--routes",
      "--base",
      "https://example.com",
      "--owner-consent",
    ]);
    expect(a).toMatchObject({
      kind: "routes",
      dir: "./src",
      base: "https://example.com/",
      ownerConsent: true,
      ci: false,
    });
    const b = parseCliArgs(["./src", "--base", "example.com", "--routes", "--ci"]);
    expect(b).toMatchObject({
      kind: "routes",
      base: "https://example.com/",
      ci: true,
      ownerConsent: false,
    });
  });

  it("--routes with a glob keeps its earlier meaning: download routes, against an address", () => {
    const a = parseCliArgs(["example.com", "--owner-consent", "--routes", "app/api/**/route.ts"]);
    expect(a).toMatchObject({ kind: "run", routes: ["app/api/**/route.ts"], ownerConsent: true });
  });

  it("--routes both with and without a glob, two folders and a bad --base are usage errors", () => {
    expect(
      parseCliArgs(["./src", "--routes", "--routes", "a/**", "--base", "example.com"]),
    ).toMatchObject({
      kind: "error",
      message: expect.stringContaining("both with and without a glob"),
    });
    expect(parseCliArgs(["./a", "./b", "--routes", "--base", "example.com"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Expected one folder"),
    });
    expect(parseCliArgs(["--routes", "--base", "example.com"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("needs the folder"),
    });
    expect(parseCliArgs(["./src", "--routes", "--base", "not an address"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--base:"),
    });
  });

  it("--base without --routes on the page check says what it is for", () => {
    expect(parseCliArgs(["example.com", "--base", "https://example.com"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--base is read by gaugeline plan"),
    });
  });

  it("--routes and --base are in --help for the page check", () => {
    const names = FLAGS.filter((f) => f.commands.includes("check")).map((f) => f.name);
    expect(names).toContain("base");
    expect(HELP[""]).toContain("--base <value>");
    expect(HELP[""]).toContain("with no glob, ask each signed-in route");
    expect(HELP[""]).toContain("gaugeline check <folder> --routes --base <address>");
  });
});
