import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { bin } from "./helpers/bin.js";

/** ADR-0003: the CLI contacts only the site it was asked to check and destinations the user configured. */
const preload = fileURLToPath(new URL("./helpers/record-connections.cjs", import.meta.url));
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});
function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
async function fixture(name: string): Promise<Fixture> {
  const f = await startFixture(name);
  cleanup.push(() => f.close());
  return f;
}

/** Run the built bin with every outbound connection recorded. */
async function recordedRun(args: string[], env: Record<string, string> = {}) {
  const dir = temp("gaugeline-phone-");
  const log = join(dir, "connections.log");
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["CI", "FORCE_COLOR", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"])
    delete childEnv[k];
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ["--require", preload, bin, ...args, "--allow-private"], {
      env: { ...childEnv, NO_COLOR: "1", GAUGELINE_RECORD_CONNECTIONS: log, ...env },
      stdio: "ignore",
    });
    child.on("close", (c) => resolve(c ?? -1));
  });
  const hosts = existsSync(log)
    ? [...new Set(readFileSync(log, "utf8").split("\n").filter(Boolean))]
    : [];
  return { code, hosts };
}
const hostOf = (origin: string) => new URL(origin).host;

describe("no phone home: e2e", () => {
  it("a check against a fixture contacts only the fixture's own origin", async () => {
    const site = await fixture("clean");
    const r = await recordedRun([`${site.origin}/`]);
    expect(r.code).toBe(0);
    expect(r.hosts.length).toBeGreaterThan(0);
    expect(r.hosts).toEqual([hostOf(site.origin)]);
  }, 30_000);

  it("with a webhook configured to a local sink, the sink is the only other host allowed", async () => {
    const site = await fixture("clean");
    const sink = createServer((_q, res) => void res.writeHead(204).end());
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise<void>((r) => sink.close(() => r())));
    const sinkHost = `127.0.0.1:${(sink.address() as AddressInfo).port}`;
    const r = await recordedRun([`${site.origin}/`], {
      GAUGELINE_SLACK_WEBHOOK: `http://${sinkHost}/hook`,
    });
    expect(r.hosts.filter((h) => h !== hostOf(site.origin) && h !== sinkHost)).toEqual([]);
  }, 30_000);
});

describe("no phone home: promise test", () => {
  it("the recorded requests to the checked site are GET or HEAD only", async () => {
    const site = await fixture("clean");
    await recordedRun([`${site.origin}/`]);
    expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    expect(site.total).toBeGreaterThan(0);
  }, 30_000);
});

describe("no phone home: edge cases", () => {
  it("a run that fails with exit 2 contacts no host other than the one it could not reach", async () => {
    const site = await fixture("clean");
    const origin = site.origin;
    await site.close();
    const r = await recordedRun([`${origin}/`]);
    expect(r.code).toBe(2);
    expect(r.hosts.every((h) => h === hostOf(origin))).toBe(true);
  }, 30_000);

  it("the first run with an empty home directory makes no extra request and writes no id file", async () => {
    const site = await fixture("clean");
    const home = temp("gaugeline-home-");
    const r = await recordedRun([`${site.origin}/`], {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    });
    expect(r.hosts).toEqual([hostOf(site.origin)]);
    expect(readdirSync(home)).toEqual([]);
  }, 30_000);
});
