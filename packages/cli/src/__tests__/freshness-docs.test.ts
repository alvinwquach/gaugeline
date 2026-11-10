import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIMITS,
  MAX_FORECAST_ITEMS,
  MAX_SPOT_CHECKS,
  cacheNote,
  isActive,
  numberFrom,
  parseDuration,
  parseMoment,
  parseTolerance,
} from "@gaugeline/core";
import { SITES_DIR } from "@gaugeline/fixtures";
import { staticSite } from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  startFakePostgres,
  type FakePostgres,
} from "../../../core/src/connectors/postgres/__tests__/fake-postgres.js";
import { main } from "../main.js";

/**
 * docs/guides/data-freshness.md shows three configurations and what they print. The stats site
 * needs a database and every example needs a fixed clock, so the docs runner (pnpm docs:examples)
 * cannot run them; this test does, against a stand-in Postgres and the invented sites in the
 * fixtures folder, at 12:00 UTC on 10 November 2026, and compares what the page prints with what the
 * CLI prints. It also checks that the page's configuration blocks are the fixtures' files, so the
 * page cannot drift from the tool.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/data-freshness.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const PASSWORD = ["harbor", "pw", "0123456789"].join("-");
const NOV = new Date("2026-11-10T12:00:00Z");
const JULY = new Date("2026-07-15T12:00:00Z");

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
  harbor: {
    fixture: "freshness-stats",
    host: "harbor.example",
    freshness: "gaugeline.freshness.json",
    sources: "gaugeline.sources.json",
  },
  juniper: {
    fixture: "freshness-bar",
    host: "juniper.example",
    freshness: "gaugeline.freshness.json (the bar)",
    sources: undefined,
  },
} as const;

async function run(site: (typeof SITES)[keyof typeof SITES], now: Date) {
  const server = await startFakePostgres({
    onQuery: (sql) => {
      if (sql.includes("current_user"))
        return {
          columns: [{ name: "role" }, { name: "strong", oid: 16 }],
          rows: [["reader", "f"]],
        };
      if (sql.includes("job = 'players'"))
        return { columns: [{ name: "value", oid: 1184 }], rows: [["2026-11-10 11:50:00+00"]] };
      if (sql.includes("job = 'standings'"))
        return { columns: [{ name: "value", oid: 1184 }], rows: [["2026-11-07 11:05:00+00"]] };
      if (sql.includes("from player_totals"))
        return {
          columns: [{ name: "key" }, { name: "value", oid: 1700 }],
          rows: [
            ["jane-example", "27.3"],
            ["sam-sample", "19.8"],
          ],
        };
      return undefined;
    },
  });
  servers.push(server);
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-freshness-docs-"));
  dirs.push(dir);
  // The page's own configuration blocks are what runs.
  writeFileSync(join(dir, "gaugeline.freshness.json"), block(site.freshness) ?? "");
  if (site.sources) writeFileSync(join(dir, "gaugeline.sources.json"), block(site.sources) ?? "");
  const out: string[] = [];
  const code = await main(
    [`https://${site.host}/`, "--no-open"],
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: () => undefined },
      env: {
        NO_COLOR: "1",
        HARBOR_DB_URL: `postgres://gaugeline_reader:${PASSWORD}@127.0.0.1:${server.port}/hoops?sslmode=disable`,
      },
    },
    {
      cwd: dir,
      version: "0.1.0",
      now: () => now,
      fetcher: {
        transport: staticSite(site.host, join(SITES_DIR, site.fixture), () =>
          Promise.reject(new Error("only the fixture host is served")),
        ),
      },
    },
  );
  return { code, out: out.join("") };
}

describe("docs/guides/data-freshness.md", () => {
  it("its configuration blocks are the files in the fixtures, so the page and the tool cannot drift", () => {
    for (const site of Object.values(SITES))
      for (const [title, file] of [
        [site.freshness, "gaugeline.freshness.json"],
        ...(site.sources ? ([[site.sources, "gaugeline.sources.json"]] as const) : []),
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
    expect(page).toContain("Harbor City Hoops");
    expect(page).toContain("Juniper Tap House");
  });

  it("each command on the page prints the lines the page says it prints", async () => {
    const [stats, bar] = examples();
    const a = await run(SITES.harbor, NOV);
    expect(a.code).toBe(0);
    expect(a.out).toContain(stats?.expected.trimEnd());
    const b = await run(SITES.juniper, NOV);
    expect(b.out).toContain(bar?.expected.trimEnd());
    // The bar has no database and no password to leak; the stats site's never reaches the output.
    expect(a.out).not.toContain(PASSWORD);
  });

  it("in July the page's off-season lines are the ones the tool prints", async () => {
    const july = block("Output in July (the lines the windowed rules add)");
    const r = await run(SITES.harbor, JULY);
    expect(r.out).toContain(july?.trimEnd());
    expect(r.out).not.toContain("is stamped");
  });

  it("the cache line on the page is the line the checks print", () => {
    const line = cacheNote({
      url: "https://harbor.example/players/jane-example",
      status: 200,
      headers: { age: "17400", "cache-control": "public, s-maxage=3600" },
      ms: 1,
    });
    expect(page).toContain(line.trim());
  });

  it("every stamp form the page lists is read by the tool", () => {
    const now = Date.UTC(2026, 10, 10, 12);
    for (const text of [
      "2026-11-10T09:30:00Z",
      "2026-11-10T04:30:00-05:00",
      "2026-11-10 09:30",
      "2026-11-09",
      "Tue, 10 Nov 2026 09:30:00 GMT",
      "1794303000",
      "1794303000000",
      "Nov 9, 2026 4:30 PM EST",
      "9 November 2026, 16:30 -05:00",
      "just now",
      "an hour ago",
      "3 hours ago",
      "2 days ago",
      "yesterday",
      "today",
    ]) {
      expect(page, text).toContain(text);
      expect(parseMoment(text, { now, timeZone: "America/New_York" }).ok, text).toBe(true);
    }
  });

  it("the durations, tolerances and months the page shows are accepted", () => {
    for (const text of ["6h", "2d", "90m", "1w"]) {
      expect(page).toContain(`"${text}"`);
      expect(parseDuration(text), text).toBeDefined();
    }
    expect(parseTolerance(0.1)).toBeDefined();
    expect(parseTolerance("2%")).toBeDefined();
    for (const text of ["1,234.5", "$12.50", "48.2%", "27.3 PPG"]) {
      expect(page).toContain(text);
      expect(numberFrom(text), text).toBeDefined();
    }
    expect(numberFrom("27,3")).toBeUndefined();
    const season = { months: [10, 11, 12, 1, 2, 3, 4, 5, 6] };
    expect(isActive(season, NOV.getTime(), "America/New_York")).toBe(true);
    expect(isActive(season, JULY.getTime(), "America/New_York")).toBe(false);
  });

  it("states the limits the code uses", () => {
    expect(page).toContain(`**${LIMITS.statePages}**`);
    expect(page).toContain(
      `at most ${MAX_SPOT_CHECKS === 5 ? "five" : MAX_SPOT_CHECKS} spot checks`,
    );
    expect(page).toContain(`up to ${MAX_FORECAST_ITEMS} are read`);
    expect(page).toContain("(at most 20)");
  });
});
