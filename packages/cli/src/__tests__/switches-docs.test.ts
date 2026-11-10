import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, MAX_STATE_PAGES, cacheNote, switchValue } from "@gaugeline/core";
import { SITES_DIR } from "@gaugeline/fixtures";
import { staticSite, useCassette } from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  startFakePostgres,
  type FakePostgres,
} from "../../../core/src/connectors/postgres/__tests__/fake-postgres.js";
import { main } from "../main.js";

/**
 * docs/guides/switches-and-availability.md shows two configurations and what they print. They need
 * Sanity and a database, so the docs runner (pnpm docs:examples) cannot run them; this test does,
 * against a recorded Sanity answer, a stand-in Postgres and the invented sites in the fixtures
 * folder, and compares what the page prints with what the CLI prints. It also checks that the
 * page's configuration blocks are the fixtures' files, so the page cannot drift from the tool.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/switches-and-availability.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const PASSWORD = ["pop", "pw", "0123456789"].join("-");

function fences(): Array<{ info: string; body: string }> {
  const out: Array<{ info: string; body: string }> = [];
  const re = /^```(.*)\n([\s\S]*?)\n```$/gm;
  for (let m = re.exec(page); m; m = re.exec(page))
    out.push({ info: m[1] ?? "", body: m[2] ?? "" });
  return out;
}
const block = (title: string): string | undefined =>
  fences().find((f) => f.info.includes(`title="${title}"`))?.body;

/** Each `$ ... npx gaugeline ...` block with the Output block that follows it. */
function examples(): Array<{ command: string; expected: string }> {
  const all = fences();
  const out: Array<{ command: string; expected: string }> = [];
  all.forEach((f, i) => {
    const next = all[i + 1];
    if (!/title=Terminal/.test(f.info) || !/^\$ .*npx gaugeline/.test(f.body)) return;
    if (!next || !/title="?Output/.test(next.info)) return;
    out.push({ command: f.body, expected: next.body });
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

const SITES = {
  marigold: {
    fixture: "switches-popup",
    host: "marigold.example",
    switches: "gaugeline.switches.json",
    sources: "gaugeline.sources.json",
    envVar: "MARIGOLD_SUPABASE_DB_URL",
    rows: (sql: string) =>
      sql.includes("from menu_items")
        ? { columns: [{ name: "name" }], rows: [["Pozole rojo"], ["Tamales de rajas"]] }
        : sql.includes("pre_order_lines")
          ? { columns: [{ name: "value", oid: 23 }], rows: [["0"]] }
          : undefined,
  },
  lantern: {
    fixture: "switches-bar",
    host: "lantern.example",
    switches: "gaugeline.switches.json (the bar)",
    sources: "gaugeline.sources.json (the bar)",
    envVar: "LANTERN_SUPABASE_DB_URL",
    rows: (sql: string) =>
      sql.includes("from kitchen_items")
        ? { columns: [{ name: "name" }], rows: [["Fried pickles"], ["Smash burgers"]] }
        : undefined,
  },
} as const;

async function run(site: (typeof SITES)[keyof typeof SITES]) {
  const server = await startFakePostgres({
    onQuery: (sql) =>
      sql.includes("current_user")
        ? { columns: [{ name: "role" }, { name: "strong", oid: 16 }], rows: [["reader", "f"]] }
        : site.rows(sql),
  });
  servers.push(server);
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-switches-docs-"));
  dirs.push(dir);
  // The page's own configuration blocks are what runs.
  writeFileSync(join(dir, "gaugeline.switches.json"), block(site.switches) ?? "");
  writeFileSync(join(dir, "gaugeline.sources.json"), block(site.sources) ?? "");
  const out: string[] = [];
  const code = await main(
    [`https://${site.host}/`, "--no-open"],
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: () => undefined },
      env: {
        NO_COLOR: "1",
        SANITY_PROJECT_ID: "mar1gold",
        [site.envVar]: `postgres://gaugeline_reader:${PASSWORD}@127.0.0.1:${server.port}/db?sslmode=disable`,
      },
    },
    {
      cwd: dir,
      version: "0.1.0",
      fetcher: {
        transport: staticSite(
          site.host,
          join(SITES_DIR, site.fixture),
          useCassette("sanity-switches", { mode: "replay" }),
        ),
      },
    },
  );
  return { code, out: out.join("") };
}

describe("docs/guides/switches-and-availability.md", () => {
  it("its configuration blocks are the files in the fixtures, so the page and the tool cannot drift", () => {
    for (const site of Object.values(SITES))
      for (const [title, file] of [
        [site.switches, "gaugeline.switches.json"],
        [site.sources, "gaugeline.sources.json"],
      ] as const) {
        const onPage: unknown = JSON.parse(block(title) ?? "null");
        const inFixture: unknown = JSON.parse(
          readFileSync(join(SITES_DIR, site.fixture, file), "utf8"),
        );
        expect(onPage, `${site.fixture}/${file}`).toEqual(inFixture);
      }
  });

  it("has an example for each invented business, with commands and output to compare", () => {
    expect(examples().length).toBe(2);
    expect(page).toContain("Marigold Tamales");
    expect(page).toContain("The Copper Lantern");
  });

  it("each command on the page prints the lines the page says it prints", async () => {
    const found = examples();
    const [pop, bar] = found;
    const a = await run(SITES.marigold);
    expect(a.code).toBe(0);
    expect(a.out).toContain(pop?.expected.trimEnd());
    const b = await run(SITES.lantern);
    expect(b.out).toContain(bar?.expected.trimEnd());
    // The bar's clean page is not mentioned.
    expect(b.out).not.toContain("/tonight still");
  });

  it("the cache line on the page is the line the check prints", () => {
    const line = cacheNote({
      url: "https://marigold.example/order",
      status: 200,
      headers: { age: "3140", "cache-control": "public, s-maxage=3600" },
      ms: 1,
    });
    expect(page).toContain(line.trim());
  });

  it("the values the page lists as on and off are the ones the tool reads", () => {
    for (const word of ["true", "1", "on", "yes", "enabled", "open"])
      expect(switchValue(word), word).toBe("on");
    for (const word of ["false", "0", "off", "no", "disabled", "closed"])
      expect(switchValue(word), word).toBe("off");
    expect(page).toContain("`on`,\n`off`, `yes`, `no`, `enabled`, `disabled`, `open`, `closed`");
  });

  it("states the limit the code uses", () => {
    expect(MAX_STATE_PAGES).toBe(LIMITS.statePages);
    expect(page).toContain(`at most **${LIMITS.statePages}** different pages`);
  });
});
