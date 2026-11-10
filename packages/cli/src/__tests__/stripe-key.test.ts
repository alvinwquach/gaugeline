import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { REPORT_FILE, main } from "../main.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// Key-shaped values built at run time, so no secret scanner sees a literal.
const SK_LIVE = ["sk", "live", "PopUpKitchenSecret0123456789"].join("_");
const SK_TEST = ["sk", "test", "PopUpKitchenSecret0123456789"].join("_");
const RK_LIVE = ["rk", "live", "PopUpKitchenRestricted0123456"].join("_");

async function run(env: Record<string, string>, extra: string[] = []) {
  const site = await startFixture("quick-start");
  const cwd = mkdtempSync(join(tmpdir(), "gaugeline-stripe-"));
  dirs.push(cwd);
  try {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1", ...env },
    };
    const code = await main([site.origin, "--allow-private", "--no-open", ...extra], io, { cwd });
    let html = "";
    try {
      html = readFileSync(join(cwd, REPORT_FILE), "utf8");
    } catch {
      // no report was written: the run stopped before it
    }
    return { code, stdout: out.join(""), stderr: err.join(""), html, requests: site.total };
  } finally {
    await site.close();
  }
}

describe("a Stripe secret key is refused: e2e", () => {
  it("a live secret key exits 2 before any request, and stderr explains the restricted key", async () => {
    const r = await run({ STRIPE_API_KEY: SK_LIVE });
    expect(r.code).toBe(2);
    expect(r.requests).toBe(0);
    expect(r.stderr).toMatch(/restricted key that can read products and prices/);
    expect(r.stderr).toContain("--allow-secret-key");
    expect(r.stdout).toBe("");
    for (const text of [r.stdout, r.stderr, r.html]) {
      expect(text).not.toContain(SK_LIVE);
      expect(text).not.toContain("PopUpKitchenSecret");
    }
  });

  it("with --allow-secret-key the run goes ahead with one notice on stderr", async () => {
    const r = await run({ STRIPE_API_KEY: SK_LIVE }, ["--allow-secret-key"]);
    expect([0, 1]).toContain(r.code);
    expect(r.requests).toBeGreaterThan(0);
    expect(r.stderr.match(/STRIPE_API_KEY/g)).toHaveLength(1);
    expect(r.stderr).toMatch(/restricted key/);
    for (const text of [r.stdout, r.stderr, r.html]) expect(text).not.toContain(SK_LIVE);
  });

  it("a test secret key is accepted with a notice", async () => {
    const r = await run({ STRIPE_API_KEY: SK_TEST });
    expect([0, 1]).toContain(r.code);
    expect(r.stderr).toMatch(/test/);
    for (const text of [r.stdout, r.stderr, r.html]) expect(text).not.toContain(SK_TEST);
  });

  it("a restricted key runs with no notice about it", async () => {
    const r = await run({ STRIPE_API_KEY: RK_LIVE });
    expect([0, 1]).toContain(r.code);
    expect(r.stderr).not.toMatch(/STRIPE_API_KEY/);
    for (const text of [r.stdout, r.stderr, r.html]) expect(text).not.toContain(RK_LIVE);
  });

  it("no STRIPE_API_KEY at all is not an error", async () => {
    const r = await run({});
    expect([0, 1]).toContain(r.code);
    expect(r.stderr).not.toMatch(/STRIPE_API_KEY/);
  });

  it("--json with a refused key writes nothing to stdout", async () => {
    const r = await run({ STRIPE_API_KEY: SK_LIVE }, ["--json"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
  });
});
