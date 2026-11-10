import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SITES_DIR } from "@gaugeline/fixtures";
import { staticSite, useCassette } from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  startFakePostgres,
  type FakePostgres,
} from "../../../core/src/connectors/postgres/__tests__/fake-postgres.js";
import { main } from "../main.js";

/**
 * docs/guides/data-assertions.md shows commands and their output. The commands need a database, so
 * the docs runner (pnpm docs:examples) cannot run them; this test does, against a stand-in Postgres
 * that holds the BUCK Tavern's invented rows, and compares what the page prints with what the CLI
 * prints, so the page cannot drift from the tool.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/data-assertions.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const PASSWORD = ["bar", "pw", "0123456789"].join("-");

function fences(): Array<{ info: string; body: string }> {
  const out: Array<{ info: string; body: string }> = [];
  const re = /^```(.*)\n([\s\S]*?)\n```$/gm;
  for (let m = re.exec(page); m; m = re.exec(page))
    out.push({ info: m[1] ?? "", body: m[2] ?? "" });
  return out;
}

const config = fences().find((f) => f.info.includes('title="gaugeline.sources.json"'))?.body;

/** Each `$ npx gaugeline ...` block with the Output block that follows it. */
function examples(): Array<{ command: string; expected: string; title: string }> {
  const all = fences();
  const out: Array<{ command: string; expected: string; title: string }> = [];
  all.forEach((f, i) => {
    const next = all[i + 1];
    if (!/title=Terminal/.test(f.info) || !f.body.startsWith("$ npx gaugeline")) return;
    if (!next || !/title="?Output/.test(next.info)) return;
    out.push({
      command: f.body.slice(2),
      expected: next.body,
      title: /title="?(Output[^"\s]*(?: [^"]*)?)"?/.exec(next.info)?.[1] ?? "Output",
    });
  });
  return out;
}

const dirs: string[] = [];
const servers: FakePostgres[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function standIn(): Promise<FakePostgres> {
  const server = await startFakePostgres({
    onQuery: (sql) => {
      if (sql.includes("from private_events"))
        return {
          columns: [
            { name: "booking_id", oid: 23 },
            { name: "clashes_with", oid: 23 },
            { name: "room" },
            { name: "starts_at" },
          ],
          rows: [["41", "42", "Loft", "2026-12-05T19:00:00.000Z"]],
        };
      if (sql.includes("current_user"))
        return {
          columns: [{ name: "role" }, { name: "strong", oid: 16 }],
          rows: [["gaugeline_reader", "f"]],
        };
      return undefined;
    },
  });
  servers.push(server);
  return server;
}

async function run(args: string[], server: FakePostgres): Promise<{ code: number; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-assertions-docs-"));
  dirs.push(dir);
  writeFileSync(join(dir, "gaugeline.sources.json"), config ?? "");
  const out: string[] = [];
  const code = await main(
    args,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: () => undefined },
      env: {
        NO_COLOR: "1",
        BUCK_SUPABASE_DB_URL: `postgres://gaugeline_reader:${PASSWORD}@127.0.0.1:${server.port}/bar?sslmode=disable`,
      },
    },
    {
      cwd: dir,
      version: "0.1.0",
      fetcher: {
        transport: staticSite(
          "buck.example",
          `${SITES_DIR}clean`,
          useCassette("sanity-products", { mode: "replay" }),
        ),
      },
    },
  );
  return { code, out: out.join("") };
}

describe("docs/guides/data-assertions.md", () => {
  it("has a config block that is a valid gaugeline.sources.json, and examples to compare", () => {
    expect(config).toBeDefined();
    expect(examples().length).toBeGreaterThanOrEqual(4);
  });

  it("every assert command on the page prints what the page says it prints", async () => {
    for (const e of examples().filter((x) => x.command.startsWith("npx gaugeline assert"))) {
      const server = await standIn();
      const argv = e.command.replace(/^npx gaugeline /, "").split(" ");
      const r = await run(argv, server);
      expect(r.out.trimEnd(), e.command).toBe(e.expected.trimEnd());
    }
  });

  it("the exit codes the page states are the ones the commands give", async () => {
    const server = await standIn();
    expect((await run(["assert", "no-overlapping-bookings"], server)).code).toBe(1);
    expect((await run(["assert", "no-open-holds-past-expiry"], server)).code).toBe(0);
    expect((await run(["assert", "--list"], server)).code).toBe(0);
  });

  it("the lines the page shows for a normal check are in the check's output", async () => {
    const e = examples().find((x) => x.command === "npx gaugeline buck.example");
    expect(e).toBeDefined();
    const server = await standIn();
    const r = await run(["https://buck.example/", "--no-open"], server);
    expect(r.out).toContain(e?.expected.trimEnd());
  });

  it("states the limits the code uses", () => {
    expect(page).toContain("first 20 rows");
    expect(page).toContain("5,000 rows");
    expect(page).toContain("140 characters");
    expect(page).toContain("20,000 characters");
    expect(page).toContain("5 seconds");
  });
});
