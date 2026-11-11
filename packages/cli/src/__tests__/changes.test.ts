import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type FixtureServer } from "../../../core/src/__tests__/helpers/server.js";
import { parseCliArgs } from "../args.js";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { hostDir, readRuns } from "../runs.js";

const servers: FixtureServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "gaugeline-changes-"));
  dirs.push(d);
  return d;
};

/** Harbour Bar's events page: the owner can drop the booking link and the price changes between runs. */
async function bar(state: { price: string; book: boolean }) {
  const server = await startServer({
    "/": (_req: IncomingMessage, res: ServerResponse) => {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<html><head><title>Events</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", sku: "QUIZ-TICKET", offers: { price: state.price, priceCurrency: "USD" } })}</script></head><body><main><h1>Events</h1><p>Quiz night</p>${state.book ? '<a href="/book">Book a table</a>' : ""}</main></body></html>`,
        );
    },
  });
  servers.push(server);
  return server;
}

async function run(argv: string[], cwd: string, at: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
      now: () => new Date(at),
    },
    { cwd },
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("gaugeline changes: arguments and help", () => {
  it("takes one site, and --since as a date or a run id", () => {
    expect(parseCliArgs(["changes", "harbourbar.example"], {})).toMatchObject({
      kind: "changes",
      address: "https://harbourbar.example/",
      json: false,
    });
    expect(
      parseCliArgs(["changes", "harbourbar.example", "--since", "2026-11-01"], {}),
    ).toMatchObject({ since: "2026-11-01" });
    expect(
      parseCliArgs(["changes", "harbourbar.example", "--since", "r-20261101T100000Z"], {}),
    ).toMatchObject({ since: "r-20261101T100000Z" });
  });
  it("refuses no site, two sites, and a since that is neither", () => {
    expect(parseCliArgs(["changes"], {})).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["changes", "a.example", "b.example"], {})).toMatchObject({
      kind: "error",
    });
    expect(parseCliArgs(["changes", "a.example", "--since", "yesterday"], {})).toMatchObject({
      kind: "error",
    });
  });
  it("--since last is still the only value for a page check", () => {
    expect(parseCliArgs(["a.example", "--since", "2026-11-01"], {})).toMatchObject({
      kind: "error",
    });
  });
  it("every flag the help lists for changes is a flag the parser knows, and the help names the command", () => {
    const names = flagsFor(FLAGS, "changes").map((f) => `--${f.name}`);
    for (const n of names) expect(HELP.changes).toContain(n);
    expect(FLAGS.find((f) => f.name === "since")?.commands).toContain("changes");
  });
});

describe("gaugeline changes: end to end", () => {
  it("--since last keeps each run; changes names the link that went and says the records cannot say who", async () => {
    const state = { price: "12.00", book: true };
    const server = await bar(state);
    const cwd = tmp();
    await run(
      [server.origin, "--no-open", "--allow-private", "--since", "last"],
      cwd,
      "2026-11-01T10:00:00Z",
    );
    state.price = "14.00";
    state.book = false;
    await run(
      [server.origin, "--no-open", "--allow-private", "--since", "last"],
      cwd,
      "2026-11-03T10:00:00Z",
    );
    const host = new URL(server.origin).host;
    const stored = readRuns(cwd, host).runs;
    expect(stored.map((r) => r.id)).toEqual(["r-20261101T100000Z", "r-20261103T100000Z"]);
    // Fields and hashes, never the page.
    expect(readFileSync(join(hostDir(cwd, host), "r-20261103T100000Z.json"), "utf8")).not.toContain(
      "Quiz night",
    );

    const text = await run(["changes", server.origin], cwd, "2026-11-04T10:00:00Z");
    expect(text.code).toBe(0);
    expect(text.out).toContain("price-changed on /");
    expect(text.out).toContain("link removed: /book");
    expect(text.out).toContain("unknown: Gaugeline cannot tell what changed it");
    expect(text.out).not.toMatch(/fault|blame/i);

    const json = JSON.parse(
      (await run(["changes", server.origin, "--json"], cwd, "2026-11-04T10:00:00Z")).out,
    );
    expect(
      json.items.find(
        (i: { finding: { checkId: string } }) => i.finding.checkId === "price-changed",
      ),
    ).toMatchObject({
      label: "unknown",
      finding: { checkId: "price-changed", path: "/" },
    });
  });

  it("with a warranty in gaugeline.changes.json the note says inside or after, and no price", async () => {
    const state = { price: "12.00", book: true };
    const server = await bar(state);
    const cwd = tmp();
    writeFileSync(
      join(cwd, "gaugeline.changes.json"),
      JSON.stringify({ warranty: { ends: "2026-11-02", covers: "bugs in the build" } }),
    );
    await run(
      [server.origin, "--no-open", "--allow-private", "--since", "last"],
      cwd,
      "2026-11-01T10:00:00Z",
    );
    state.price = "14.00";
    await run(
      [server.origin, "--no-open", "--allow-private", "--since", "last"],
      cwd,
      "2026-11-03T10:00:00Z",
    );
    const out = (await run(["changes", server.origin], cwd, "2026-11-04T10:00:00Z")).out;
    expect(out).toContain("after the warranty period");
    expect(
      out
        .split("\n")
        .filter((l) => l.includes("warranty"))
        .join(""),
    ).not.toMatch(/[$£€]|price|\bfee\b/i);
  });

  it("a first run says so, with no section; a site never run says to run it", async () => {
    const server = await bar({ price: "12.00", book: true });
    const cwd = tmp();
    expect((await run(["changes", server.origin], cwd, "2026-11-01T10:00:00Z")).out).toContain(
      "No runs are stored",
    );
    await run(
      [server.origin, "--no-open", "--allow-private", "--since", "last"],
      cwd,
      "2026-11-01T10:00:00Z",
    );
    expect((await run(["changes", server.origin], cwd, "2026-11-02T10:00:00Z")).out).toContain(
      "no earlier run",
    );
  });

  it("history older than the retention is dropped and the date kept", async () => {
    const state = { price: "12.00", book: true };
    const server = await bar(state);
    const cwd = tmp();
    writeFileSync(join(cwd, "gaugeline.changes.json"), JSON.stringify({ retentionDays: 7 }));
    await run(
      [server.origin, "--no-open", "--allow-private", "--since", "last"],
      cwd,
      "2026-10-01T10:00:00Z",
    );
    state.price = "14.00";
    await run(
      [server.origin, "--no-open", "--allow-private", "--since", "last"],
      cwd,
      "2026-11-03T10:00:00Z",
    );
    const host = new URL(server.origin).host;
    expect(readdirSync(hostDir(cwd, host)).filter((f) => f.endsWith(".json"))).toEqual([
      "r-20261103T100000Z.json",
    ]);
    expect(existsSync(join(hostDir(cwd, host), "pruned-before.txt"))).toBe(true);
    const out = (await run(["changes", server.origin], cwd, "2026-11-04T10:00:00Z")).out;
    expect(out).toContain("Changed before 27 Oct 2026, history not kept.");
  });
});
