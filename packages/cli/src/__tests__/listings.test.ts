import { mkdtempSync, rmSync, writeFileSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, expectedOutput } from "@gaugeline/fixtures";
import { staticSite, useCassette } from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { REPORT_FILE, main } from "../main.js";

const BAR = `${SITES_DIR}listings-bar`;
const HOST = "bucktavern.example";
const KEYS = {
  GOOGLE_BUSINESS_PROFILE_TOKEN: ["ya29", "invented", "bar", "token", "0123456789abcdef"].join("."),
  YELP_API_KEY: ["invented", "yelp", "key", "0123456789abcdef"].join("_"),
};
const NOW = () => new Date("2026-11-10T18:00:00Z");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A folder with the bar's config and Apple export, so the report a run writes never lands in the fixture. */
function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-listings-"));
  dirs.push(dir);
  for (const f of ["gaugeline.listings.json", "apple-business-connect.csv"])
    cpSync(join(BAR, f), join(dir, f));
  return dir;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" } as Record<string, string | undefined>,
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

function transport(cassette: string) {
  return staticSite(HOST, BAR, useCassette(cassette, { mode: "replay" }));
}

describe("listings: end to end (CLI, recorded Google and Yelp answers)", () => {
  it("the bar with its gaugeline.listings.json prints exactly the listings guide's Output block", async () => {
    const run = capture();
    Object.assign(run.io.env, KEYS);
    const code = await main([`https://${HOST}/`, "--no-open"], run.io, {
      version: "0.1.0",
      cwd: workdir(),
      now: NOW,
      fetcher: { transport: transport("listings-bucktavern") },
    });
    expect(code).toBe(0);
    expect(withoutPassed(run.out()).trimEnd()).toBe(
      expectedOutput("connectors/listings", "Example: a neighbourhood bar that changed its name"),
    );
  });

  it("without gaugeline.listings.json the listing checks are not run: nothing passed, nothing asked of Google or Yelp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-listings-"));
    dirs.push(dir);
    const run = capture();
    const asked: string[] = [];
    const base = transport("listings-bucktavern");
    const code = await main([`https://${HOST}/`, "--no-open", "--json"], run.io, {
      version: "0.1.0",
      cwd: dir,
      now: NOW,
      fetcher: {
        transport: (url, req) => {
          asked.push(url.hostname);
          return base(url, req);
        },
      },
    });
    expect(code, run.err()).toBe(0);
    const result = JSON.parse(run.out()) as {
      passed: string[];
      failed: string[];
      findings: { checkId: string }[];
    };
    expect(result.findings.filter((f) => f.checkId.startsWith("listing-"))).toEqual([]);
    expect(result.passed.filter((id) => id.startsWith("listing-"))).toEqual([]);
    expect(result.failed.filter((id) => id.startsWith("listing-"))).toEqual([]);
    expect(asked.filter((h) => /googleapis|yelp/.test(h))).toEqual([]);
  });

  it("with no key set, each source is could-not-check and says which variable to set", async () => {
    const run = capture();
    const code = await main([`https://${HOST}/`, "--no-open", "--json"], run.io, {
      version: "0.1.0",
      cwd: workdir(),
      now: NOW,
      fetcher: { transport: transport("listings-bucktavern") },
    });
    expect(code).toBe(0);
    const result = JSON.parse(run.out()) as {
      passed: string[];
      couldNotCheck: { id: string; reason: string }[];
    };
    const reasons = result.couldNotCheck.map((c) => c.reason);
    expect(reasons.some((r) => r.includes("Set GOOGLE_BUSINESS_PROFILE_TOKEN"))).toBe(true);
    expect(reasons.some((r) => r.includes("Set YELP_API_KEY"))).toBe(true);
    // A check that could not read a source has not passed.
    for (const id of ["listing-name-mismatch", "listing-hours-mismatch", "listing-phone-mismatch"])
      expect(result.passed).not.toContain(id);
  });

  it("the keys reach no output: stdout, stderr (--verbose), the JSON result and the HTML report", async () => {
    const cwd = workdir();
    const first = capture();
    Object.assign(first.io.env, KEYS);
    await main([`https://${HOST}/`, "--no-open", "--verbose"], first.io, {
      version: "0.1.0",
      cwd,
      now: NOW,
      fetcher: { transport: transport("listings-bucktavern") },
    });
    const html = readFileSync(join(cwd, REPORT_FILE), "utf8");
    const second = capture();
    Object.assign(second.io.env, KEYS);
    await main([`https://${HOST}/`, "--no-open", "--json"], second.io, {
      version: "0.1.0",
      cwd,
      now: NOW,
      fetcher: { transport: transport("listings-bucktavern") },
    });
    const seen = { stdout: first.out(), stderr: first.err(), json: second.out(), html };
    expect(seen.html.length).toBeGreaterThan(100);
    for (const [where, text] of Object.entries(seen))
      for (const [name, value] of Object.entries(KEYS))
        expect(text.includes(value), `${name} found in ${where}`).toBe(false);
  });

  it("a bad gaugeline.listings.json stops the run naming the field (exit 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-listings-bad-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "gaugeline.listings.json"),
      JSON.stringify({
        bios: [{ name: "Instagram", url: "https://www.instagram.com/bucktavern/" }],
      }),
    );
    const run = capture();
    expect(await main([`https://${HOST}/`, "--no-open"], run.io, { cwd: dir })).toBe(2);
    expect(run.err()).toContain("gaugeline.listings.json: bios.0.url:");
    expect(run.err()).toContain("never requests");
  });

  it("an Apple export that is not there stops the run naming the file (exit 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-listings-apple-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "gaugeline.listings.json"),
      JSON.stringify({ apple: { csv: "missing.csv" } }),
    );
    const run = capture();
    expect(await main([`https://${HOST}/`, "--no-open"], run.io, { cwd: dir })).toBe(2);
    expect(run.err()).toContain("gaugeline.listings.json: apple.csv: missing.csv was not found.");
  });
});
