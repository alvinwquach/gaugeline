import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR } from "@gaugeline/fixtures";
import { SWITCH_CHECKS } from "@gaugeline/core";
import { staticSite, useCassette } from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  startFakePostgres,
  type FakePostgres,
  type FakeReply,
} from "../../../core/src/connectors/postgres/__tests__/fake-postgres.js";
import { main } from "../main.js";

const HOST = "marigold.example";
const PASSWORD = ["pop", "pw", "0123456789"].join("-");
const TOKEN = ["sk", "sanity", "token", "0123456789abcdef"].join("_");

const dirs: string[] = [];
const servers: FakePostgres[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function workdir(files: Record<string, unknown> | "popup"): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-switches-"));
  dirs.push(dir);
  if (files === "popup")
    for (const f of ["gaugeline.switches.json", "gaugeline.sources.json"])
      cpSync(join(SITES_DIR, "switches-popup", f), join(dir, f));
  else
    for (const [name, body] of Object.entries(files))
      writeFileSync(join(dir, name), JSON.stringify(body));
  return dir;
}

async function database(answers: Record<string, FakeReply>): Promise<FakePostgres> {
  const server = await startFakePostgres({
    onQuery: (sql) => {
      if (sql.includes("current_user"))
        return {
          columns: [{ name: "role" }, { name: "strong", oid: 16 }],
          rows: [["reader", "f"]],
        };
      for (const [word, reply] of Object.entries(answers)) if (sql.includes(word)) return reply;
      return undefined;
    },
  });
  servers.push(server);
  return server;
}

const TROUBLE: Record<string, FakeReply> = {
  "from menu_items": { columns: [{ name: "name" }], rows: [["Pozole rojo"], ["Tamales de rajas"]] },
  "from pre_order_lines": { columns: [{ name: "value", oid: 23 }], rows: [["0"]] },
};

async function run(
  args: string[],
  dir: string,
  env: Record<string, string | undefined> = {},
  requests: Array<{ method: string; url: string }> = [],
) {
  const out: string[] = [];
  const err: string[] = [];
  const replay = useCassette("sanity-switches", { mode: "replay" });
  const inner = staticSite(HOST, join(SITES_DIR, "switches-popup"), replay);
  const code = await main(
    args,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1", ...env },
    },
    {
      cwd: dir,
      version: "0.1.0",
      fetcher: {
        transport: (url, req) => {
          requests.push({ method: req.method, url: url.href });
          return inner(url, req);
        },
      },
    },
  );
  return { code, out: out.join(""), err: err.join("") };
}

const connection = (server: FakePostgres): string =>
  `postgres://gaugeline_reader:${PASSWORD}@127.0.0.1:${server.port}/pop?sslmode=disable`;

describe("gaugeline.switches.json in the CLI", () => {
  it("a bad file stops the run naming the file and the field (exit 2)", async () => {
    const dir = workdir({
      "gaugeline.switches.json": {
        switches: [{ id: "a", source: "mysql:x.y", whenOff: { noLinksTo: ["/x"] } }],
      },
    });
    const r = await run([`https://${HOST}/`, "--no-open"], dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain("gaugeline.switches.json: switches.0.source:");
  });

  it("a db: source with no sources file stops the run, naming the file, the source and where to fix it", async () => {
    const dir = workdir({
      "gaugeline.switches.json": {
        capacity: [
          { source: "db:tonightRemaining", whenZero: { pageSays: { "/order": "sold out" } } },
        ],
      },
    });
    const r = await run([`https://${HOST}/`, "--no-open"], dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain('gaugeline.switches.json: capacity.0.source: "db:tonightRemaining"');
    expect(r.err).toContain("gaugeline.sources.json");
    expect(r.err).toContain("docs/guides/switches-and-availability");
  });

  it("a db: source naming a query the sources file does not have stops the run", async () => {
    const dir = workdir({
      "gaugeline.switches.json": {
        capacity: [{ source: "db:nope", whenZero: { pageSays: { "/order": "sold out" } } }],
      },
      "gaugeline.sources.json": {
        sources: { db: { type: "postgres", queries: { other: "select 1" } } },
      },
    });
    const r = await run([`https://${HOST}/`, "--no-open"], dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain('no source in gaugeline.sources.json has a query "nope"');
  });

  it("with the file, the four checks run and print what the site got wrong", async () => {
    const server = await database(TROUBLE);
    const requests: Array<{ method: string; url: string }> = [];
    const r = await run(
      [`https://${HOST}/`, "--no-open"],
      workdir("popup"),
      { SANITY_PROJECT_ID: "mar1gold", MARIGOLD_SUPABASE_DB_URL: connection(server) },
      requests,
    );
    expect(r.err).not.toContain("could not");
    for (const text of [
      'db:tonightRemaining has 0 left, and /order does not say "sold out"; it still has an order form.',
      'preorders is off (sanity:siteSettings.features.preOrders), but / still links to /order ("Pre-order", "pre-order for tonight").',
      'preorders is off (sanity:siteSettings.features.preOrders), and /order does not say "order at the window".',
      'still shows "Tamal de rajas" (the database has "Tamales de rajas")',
      'the Menu structured data of /menu still has "Pozole rojo"',
    ])
      expect(r.out).toContain(text);
    // Reads only: every request to the site and to Sanity is a GET or HEAD, and Sanity's are GET.
    expect(requests.length).toBeGreaterThan(5);
    expect(requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
    const sanity = requests.filter((q) => q.url.includes(".api.sanity.io"));
    expect(sanity.length).toBeGreaterThan(0);
    expect(sanity.every((q) => q.method === "GET")).toBe(true);
    // Neither the connection string nor its password reaches any output.
    for (const text of [r.out, r.err]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(connection(server));
    }
  });

  it("--json lists the findings under their check ids, and the checks that passed", async () => {
    const server = await database(TROUBLE);
    const r = await run([`https://${HOST}/`, "--no-open", "--json"], workdir("popup"), {
      SANITY_PROJECT_ID: "mar1gold",
      MARIGOLD_SUPABASE_DB_URL: connection(server),
    });
    const result = JSON.parse(r.out) as { findings: Array<{ checkId: string }> };
    const ids = new Set(result.findings.map((f) => f.checkId));
    for (const id of SWITCH_CHECKS) expect(ids.has(id), id).toBe(true);
  });

  it("with the variables unset, every check says it could not check and names the variable (never a pass)", async () => {
    const r = await run([`https://${HOST}/`, "--no-open", "--json"], workdir("popup"), {});
    const result = JSON.parse(r.out) as {
      findings: Array<{ checkId: string }>;
      passed: string[];
      couldNotCheck: Array<{ id: string; reason: string }>;
    };
    expect(result.findings.filter((f) => SWITCH_CHECKS.includes(f.checkId))).toEqual([]);
    for (const id of SWITCH_CHECKS) expect(result.passed).not.toContain(id);
    const reasons = Object.fromEntries(result.couldNotCheck.map((c) => [c.id, c.reason]));
    expect(
      Object.keys(reasons)
        .filter((id) => SWITCH_CHECKS.includes(id))
        .sort(),
    ).toEqual([...SWITCH_CHECKS].sort());
    expect(reasons["switch-off-still-linked"]).toContain("SANITY_PROJECT_ID is not set");
    expect(reasons["capacity-zero-not-sold-out"]).toContain("MARIGOLD_SUPABASE_DB_URL");
  });

  it("without the file the switch checks are not run: neither passed nor failed", async () => {
    const r = await run([`https://${HOST}/`, "--no-open", "--json"], workdir({}));
    const result = JSON.parse(r.out) as { passed: string[]; findings: Array<{ checkId: string }> };
    for (const id of SWITCH_CHECKS) {
      expect(result.passed).not.toContain(id);
      expect(result.findings.map((f) => f.checkId)).not.toContain(id);
    }
  });

  it("a Sanity token is read from the environment, sent only in a header, and never printed", async () => {
    const server = await database(TROUBLE);
    const requests: Array<{ method: string; url: string }> = [];
    const r = await run(
      [`https://${HOST}/`, "--no-open", "--verbose"],
      workdir("popup"),
      {
        SANITY_PROJECT_ID: "mar1gold",
        SANITY_TOKEN: TOKEN,
        MARIGOLD_SUPABASE_DB_URL: connection(server),
      },
      requests,
    );
    expect(requests.some((q) => q.url.includes("mar1gold.api.sanity.io"))).toBe(true);
    for (const text of [r.out, r.err, JSON.stringify(requests)]) expect(text).not.toContain(TOKEN);
  });
});
