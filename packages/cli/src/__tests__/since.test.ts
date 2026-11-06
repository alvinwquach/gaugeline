import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type FixtureServer } from "../../../core/src/__tests__/helpers/server.js";
import { main } from "../main.js";
import { readLastRun, statePath, writeLastRun } from "../state.js";
import { runBin } from "./helpers/bin.js";

const servers: FixtureServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "gaugeline-since-"));
  dirs.push(d);
  return d;
};
// Put together at run time, so no key-shaped string is in the repository.
const SECRET = ["sk", "live", "SinceTestPlantedNotAKey00"].join("_");

/** A shop page whose price can change between runs. */
async function shop(state: { price: string; action: string }) {
  const server = await startServer({
    "/": (_req: IncomingMessage, res: ServerResponse) => {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<html><head><title>Box</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", sku: "TAMAL-BOX", offers: { price: state.price, priceCurrency: "USD" } })}</script></head><body><main><p>Tamal box. Key ${SECRET}</p><form id="order" action="${state.action}"><input type="hidden" name="token" value="${SECRET}"></form></main></body></html>`,
        );
    },
  });
  servers.push(server);
  return server;
}

async function run(origin: string, cwd: string, flags: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    env: { NO_COLOR: "1" },
    now: () => new Date("2026-11-05T20:00:00Z"),
  };
  const code = await main([origin, "--no-open", "--allow-private", ...flags], io, { cwd });
  return { code, out: out.join(""), err: err.join("") };
}

describe("--since last: integration", () => {
  it("two runs against a site whose price changes: the second run reports price-changed", async () => {
    const state = { price: "12.00", action: "https://forms.hsforms.com/submissions/v3/x" };
    const server = await shop(state);
    const cwd = tmp();
    const first = await run(server.origin, cwd, ["--since", "last"]);
    expect(first.err).toContain("nothing to compare yet\n");
    expect(first.out).not.toContain("A price changed");
    state.price = "14.00";
    state.action = "https://acme.formstack.com/forms/x";
    const second = await run(server.origin, cwd, ["--since", "last"]);
    expect(second.out).toContain(
      "A price changed since the last run\n    TAMAL-BOX: 12.00 USD last run, 14.00 USD now\n",
    );
    expect(second.out).toContain(
      "#order posts to Formstack (acme.formstack.com) now; last run it was HubSpot (forms.hsforms.com)",
    );
    expect(second.out).not.toContain("A form now posts to a different address");
  });

  it("a run without --since leaves the directory empty", async () => {
    const server = await shop({ price: "12.00", action: "/order" });
    const cwd = tmp();
    await run(server.origin, cwd, []);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("--since with anything but last is refused (exit 2)", async () => {
    const r = await run("https://pop.example/", tmp(), ["--since", "last-week"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--since accepts only last in this version, not "last-week".');
  });
});

describe("--since last: e2e (the built bin)", () => {
  it("on a clean directory it exits 0 and creates the file", async () => {
    const server = await shop({ price: "12.00", action: "/order" });
    const cwd = tmp();
    const r = await runBin(
      [server.origin, "--allow-private", "--no-open", "--since", "last"],
      {},
      { cwd },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(statePath(cwd, new URL(server.origin).host))).toBe(true);
  });
});

describe("--since last: promise (what is stored)", () => {
  it("the stored file holds no string longer than 80 characters and nothing from a planted secret", async () => {
    const server = await shop({
      price: "12.00",
      action: "https://forms.hsforms.com/submissions/v3/x",
    });
    const cwd = tmp();
    await run(server.origin, cwd, ["--since", "last"]);
    const text = readFileSync(statePath(cwd, new URL(server.origin).host), "utf8");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("Tamal box");
    const strings: string[] = [];
    JSON.parse(text, (_k, v: unknown) => {
      if (typeof v === "string") strings.push(v);
      return v;
    });
    expect(strings.filter((s) => s.length > 80)).toEqual([]);
  });
});

describe("--since last: edge cases", () => {
  const host = "pop.example";
  const snapshot = {
    schema: 1 as const,
    url: "https://pop.example/",
    takenAt: "2026-11-05T20:00:00.000Z",
    prices: { "BOX USD": 1200 },
    forms: {},
  };

  it("a corrupt stored file: warn on stderr, treat as no previous run, overwrite", async () => {
    const server = await shop({ price: "12.00", action: "/order" });
    const cwd = tmp();
    const h = new URL(server.origin).host;
    mkdirSync(join(cwd, ".gaugeline", "last-run"), { recursive: true });
    writeFileSync(statePath(cwd, h), "{ not json");
    const r = await run(server.origin, cwd, ["--since", "last"]);
    expect(r.err).toMatch(/is not valid JSON: treated as no previous run, and replaced\.\n/);
    expect(readLastRun(cwd, h).kind).toBe("ok");
  });

  it("schema 2 in the stored file: refuse to compare, say which version wrote it, and leave it", async () => {
    const server = await shop({ price: "12.00", action: "/order" });
    const cwd = tmp();
    const h = new URL(server.origin).host;
    mkdirSync(join(cwd, ".gaugeline", "last-run"), { recursive: true });
    const newer = JSON.stringify({ schema: 2, writtenBy: "Gaugeline 3.0.0" });
    writeFileSync(statePath(cwd, h), newer);
    const r = await run(server.origin, cwd, ["--since", "last"]);
    expect(r.err).toContain(
      "was written by Gaugeline 3.0.0 (schema 2); this version reads schema 1, so nothing was compared.",
    );
    expect(readFileSync(statePath(cwd, h), "utf8")).toBe(newer);
  });

  it("a run killed mid-write leaves the previous file intact: the write goes to a temp file, then a rename", () => {
    const cwd = tmp();
    writeLastRun(cwd, host, snapshot, "Gaugeline 0.1.0");
    // A killed run leaves only its half-written temp file behind; the real file is untouched.
    writeFileSync(`${statePath(cwd, host)}.99999.tmp`, '{"schema":1,"pri');
    expect(readLastRun(cwd, host)).toEqual({
      kind: "ok",
      snapshot: { ...snapshot, writtenBy: "Gaugeline 0.1.0" },
    });
    writeLastRun(cwd, host, { ...snapshot, prices: { "BOX USD": 1400 } }, "Gaugeline 0.1.0");
    const files = readdirSync(join(cwd, ".gaugeline", "last-run")).filter(
      (f) => !f.includes("99999"),
    );
    expect(files).toEqual(["pop.example.json"]);
  });
});
