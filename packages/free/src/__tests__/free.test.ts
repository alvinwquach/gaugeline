import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DnsReader } from "@gaugeline/core";
import { SITES_DIR, expectedOutput, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { main as gaugeline } from "../../../cli/src/main.js";
import { COMMANDS, HELP, main, parseStores } from "../main.js";

function capture(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env,
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function shop(): Promise<Fixture> {
  const site = await startFixture("price-stores");
  cleanups.push(() => site.close());
  return site;
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-free-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** stores.txt with the fixture's origin filled in. */
function storesFile(dir: string, origin: string, extra = ""): string {
  const text = readFileSync(`${SITES_DIR}price-stores/stores.txt`, "utf8").replaceAll(
    "{{origin}}",
    origin,
  );
  writeFileSync(join(dir, "stores.txt"), text + extra);
  return "stores.txt";
}

const quietDns: DnsReader = { txt: async () => [], mx: async () => [] };

describe("gaugeline-free: unit", () => {
  it("--help lists exactly three commands, each with its status as the page gives it", async () => {
    const run = capture();
    expect(await main(["--help"], run.io)).toBe(0);
    const commands = run
      .out()
      .split("\n")
      .filter((l) => /^ {2}(price|launch|study) /.test(l));
    expect(commands).toEqual([
      "  price <product-url>   Price agreement check (New)",
      "  launch <site>         Launch-day check (New)",
      "  study <stores.txt>    How often does a store disagree with itself?",
    ]);
    expect(COMMANDS.map((c) => c.name)).toEqual(["price", "launch", "study"]);
    expect(HELP).not.toMatch(/\(Next\)/);
  });

  it("study lines: blank lines and # comments skipped, duplicates read once", () => {
    expect(
      parseStores(
        "# stores\n\nhttps://a.example/products/x\n  https://b.example/p  \nhttps://a.example/products/x#top\n",
      ),
    ).toEqual(["https://a.example/products/x", "https://b.example/p"]);
    expect(() => parseStores("not an address")).toThrow(
      'stores.txt: "not an address" is not an address.',
    );
  });
});

describe("gaugeline-free: integration (the price-stores fixture)", () => {
  it("study with 3 stores, one disagreeing: the totals read 3 and 1", async () => {
    const site = await shop();
    const dir = scratch();
    const run = capture();
    const code = await main(["study", storesFile(dir, site.origin), "--allow-private"], run.io, {
      cwd: dir,
    });
    expect(code).toBe(0);
    expect(run.out().trimEnd().split("\n").at(-1)).toBe(
      "Stores read: 3. Stores where the prices disagree: 1.",
    );
    expect(run.out()).toContain("disagree: the page shows 48.00 but the store charges 52.00");
    expect(readFileSync(join(dir, "gaugeline-report.html"), "utf8")).toContain(
      "This product&#39;s prices disagree",
    );
  });

  it("study --json prints the raw rows", async () => {
    const site = await shop();
    const dir = scratch();
    const run = capture();
    await main(["study", storesFile(dir, site.origin), "--json", "--allow-private"], run.io, {
      cwd: dir,
    });
    const rows = JSON.parse(run.out()) as { url: string; reading?: { charged?: number } }[];
    expect(rows.map((r) => [new URL(r.url).pathname, r.reading?.charged])).toEqual([
      ["/products/mug", 5200],
      ["/products/tea", 1200],
      ["/products/bowl", undefined],
    ]);
  });
});

describe("gaugeline-free: e2e", () => {
  it("launch <fixture> prints exactly what gaugeline launch <fixture> --dns prints", async () => {
    const site = await startFixture("launch-preview");
    cleanups.push(() => site.close());
    const deps = {
      fetcher: { hosts: site.hosts },
      dns: quietDns,
      cwd: scratch(),
      now: () => new Date(0),
    };
    const free = capture({ NO_COLOR: "1" });
    const paid = capture({ NO_COLOR: "1" });
    const a = await main(["launch", site.origin, "--no-open"], free.io, deps);
    const b = await gaugeline(["launch", site.origin, "--no-open", "--dns"], paid.io, deps);
    expect(a).toBe(b);
    expect(free.out()).toBe(paid.out());
    expect(free.out()).toContain("Not yet:");
  });

  it("price <mismatch fixture> with CI=true exits 1; without CI it exits 0", async () => {
    const site = await shop();
    const dir = scratch();
    const ci = capture({ CI: "true" });
    expect(
      await main(["price", `${site.origin}/products/mug`, "--allow-private"], ci.io, { cwd: dir }),
    ).toBe(1);
    expect(ci.out().trimEnd()).toBe(
      expectedOutput("products-and-prices", "In this version: the free price agreement check"),
    );
    expect(ci.err()).toContain("Report written to ./gaugeline-report.html");
    const local = capture();
    expect(
      await main(["price", `${site.origin}/products/mug`, "--allow-private"], local.io, {
        cwd: dir,
      }),
    ).toBe(0);
    const clean = capture({ CI: "true" });
    expect(
      await main(["price", `${site.origin}/products/tea`, "--allow-private"], clean.io, {
        cwd: dir,
      }),
    ).toBe(0);
  });
});

describe("gaugeline-free: promise", () => {
  it("across all three commands the site sees GET and HEAD only, and at most 5 at once", async () => {
    const site = await shop();
    const launchSite = await startFixture("launch-preview");
    cleanups.push(() => launchSite.close());
    const dir = scratch();
    await main(["price", `${site.origin}/products/mug`, "--allow-private"], capture().io, {
      cwd: dir,
    });
    await main(["study", storesFile(dir, site.origin), "--allow-private"], capture().io, {
      cwd: dir,
    });
    await main(["launch", launchSite.origin, "--no-open"], capture().io, {
      cwd: dir,
      fetcher: { hosts: launchSite.hosts },
      dns: quietDns,
    });
    for (const s of [site, launchSite]) {
      expect([...s.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
      expect(s.maxConcurrent).toBeLessThanOrEqual(5);
    }
  });
});

describe("gaugeline-free: edge cases", () => {
  it("a store that refuses the request is counted as could not check, not as agreeing", async () => {
    const site = await shop();
    const dir = scratch();
    const run = capture();
    await main(
      [
        "study",
        storesFile(dir, site.origin, `${site.origin}/products/closed\n`),
        "--allow-private",
      ],
      run.io,
      {
        cwd: dir,
      },
    );
    expect(run.out()).toContain("could not check: refused automated readers (403)");
    expect(run.out().trimEnd().split("\n").at(-1)).toBe(
      "Stores read: 3. Stores where the prices disagree: 1. Could not check: 1.",
    );
  });

  it("no command, an unknown command, or a missing address: help or one clear line, exit 2", async () => {
    expect(await main([], capture().io)).toBe(0);
    expect(await main(["audit"], capture().io)).toBe(2);
    const run = capture();
    expect(await main(["price"], run.io)).toBe(2);
    expect(run.err()).toBe("gaugeline-free price needs one product address.\n");
  });
});
