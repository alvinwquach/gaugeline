import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { staticSite } from "../../../../testkit/src/index.js";
import {
  startFakePostgres,
  type FakePostgres,
  type FakeReply,
} from "../../connectors/postgres/__tests__/fake-postgres.js";
import { localUrl } from "../../connectors/postgres/__tests__/helpers.js";
import { sourcesConfigSchema } from "../../connectors/postgres/config.js";
import { createPageRegistry } from "../../checks/index.js";
import { createFetcher, type Fetcher, type Transport } from "../../fetcher.js";
import { FRESHNESS_CHECKS } from "../../presets.js";
import { checkSite } from "../../site.js";
import { freshnessConfigSchema } from "../config.js";

const servers: FakePostgres[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const PASSWORD = ["harbor", "pw", "0123456789"].join("-");
const IN_SEASON = new Date("2026-11-10T12:00:00Z");
const OFF_SEASON = new Date("2026-07-15T12:00:00Z");

function fixture(name: string) {
  const dir = join(SITES_DIR, name);
  const read = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), "utf8"));
  return {
    dir,
    freshness: freshnessConfigSchema.parse(read("gaugeline.freshness.json")),
    sources:
      name === "freshness-stats"
        ? sourcesConfigSchema.parse(read("gaugeline.sources.json"))
        : undefined,
  };
}

/** What the stats site's nightly job has recorded: recorded answers, not a live database. */
const SYNCS: Record<string, FakeReply> = {
  "job = 'players'": {
    columns: [{ name: "value", oid: 1184 }],
    rows: [["2026-11-10 11:50:00+00"]],
  },
  "job = 'standings'": {
    columns: [{ name: "value", oid: 1184 }],
    rows: [["2026-11-07 11:05:00+00"]],
  },
  "from player_totals": {
    columns: [{ name: "key" }, { name: "value", oid: 1700 }],
    rows: [
      ["jane-example", "27.3"],
      ["sam-sample", "19.8"],
    ],
  },
};

async function database(
  answers: Record<string, FakeReply>,
  queries: string[] = [],
): Promise<FakePostgres> {
  const server = await startFakePostgres({
    onQuery: (sql) => {
      if (sql.includes("current_user"))
        return {
          columns: [{ name: "role" }, { name: "strong", oid: 16 }],
          rows: [["reader", "f"]],
        };
      queries.push(sql);
      for (const [word, reply] of Object.entries(answers)) if (sql.includes(word)) return reply;
      return undefined;
    },
  });
  servers.push(server);
  return server;
}

interface Seen {
  method: string;
  url: string;
}

function network(host: string, dir: string, seen: Seen[]): Fetcher {
  const inner = staticSite(host, dir, () =>
    Promise.reject(new Error("only the fixture host is served")),
  );
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href });
    return inner(url, req);
  };
  return createFetcher({ transport, timeoutMs: 5000 });
}

async function runStats(now: Date, env: Record<string, string>, seen: Seen[] = []) {
  const f = fixture("freshness-stats");
  return checkSite({
    address: "https://harbor.example/",
    fetcher: network("harbor.example", f.dir, seen),
    only: FRESHNESS_CHECKS,
    registry: createPageRegistry(),
    freshness: { config: f.freshness, env: {} },
    databases: { config: f.sources!, env },
    now: () => now,
  });
}

describe("data freshness: the invented stats site at 12:00 UTC on 10 November", () => {
  it("finds the page behind its source, the stopped sync, the missing stamp, the wrong figure and the old prediction", async () => {
    const queries: string[] = [];
    const server = await database(SYNCS, queries);
    const seen: Seen[] = [];
    const { result } = await runStats(
      IN_SEASON,
      { HARBOR_DB_URL: localUrl(server.port, "reader", PASSWORD) },
      seen,
    );
    const by = (id: string) => result.findings.filter((f) => f.checkId === id);

    expect(by("data-behind-source").map((f) => [f.url, f.severity, f.evidence])).toEqual([
      [
        "https://harbor.example/players/jane-example",
        "medium",
        '/players/jane-example is stamped "2026-11-10T07:00:00Z", 4 hours 50 minutes older than db:latestPlayerSync (updated 10 minutes ago); player-pages allows 1 hour. The data is in the source, so the site is not picking it up: look at caching and revalidation.',
      ],
      [
        "https://harbor.example/players/sam-sample",
        "medium",
        "points per game on /players/sam-sample shows 19.1, and db:playerPpg has 19.8 (allowed difference 0.1; player-pages).",
      ],
    ]);

    expect(by("data-stale").map((f) => [f.url, f.severity, f.evidence])).toEqual([
      [
        "https://harbor.example/standings",
        "high",
        '/standings is stamped "2026-11-07T11:00:00Z" (3 days ago), and standings allows 24 hours. db:latestStandingsSync was last updated 3 days ago and the page is within 1 hour of it, so the sync looks stopped, not the site.',
      ],
    ]);

    expect(by("data-no-stamp").map((f) => [f.url, f.severity, f.evidence])).toEqual([
      [
        "https://harbor.example/teams/hawks",
        "low",
        "/teams/hawks shows no stamp (team-pages): nothing matches time.updated, and the page has no dateModified in its structured data.",
      ],
    ]);

    expect(by("forecast-for-past-event").map((f) => [f.url, f.severity, f.evidence])).toEqual([
      [
        "https://harbor.example/predictions",
        "medium",
        '/predictions lists 1 prediction whose event is already over (picks): "Hawks at Harbor Sat Nov 7 Pick: Harbor by 4" (2026-11-07T19:00:00Z).',
      ],
    ]);

    // Nothing else is claimed: no check is passed that did not look at something.
    expect(result.couldNotCheck).toEqual([]);
    expect(result.passed).toEqual([]);

    // Read only: the pages with GET, the database with a read-only transaction and plain SELECTs.
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET"]));
    expect(queries.every((q) => /^\s*select\b/i.test(q))).toBe(true);
    expect(queries.some((q) => /\b(insert|update|delete|drop|alter|create)\b/i.test(q))).toBe(
      false,
    );
  });

  it("reads each named page and each source once, however many checks ask", async () => {
    const queries: string[] = [];
    const server = await database(SYNCS, queries);
    const seen: Seen[] = [];
    await runStats(IN_SEASON, { HARBOR_DB_URL: localUrl(server.port, "reader", PASSWORD) }, seen);
    const pages = seen
      .map((s) => new URL(s.url).pathname)
      .filter((p) => !/robots|sitemap|og\.png/.test(p));
    for (const path of ["/standings", "/predictions"])
      expect(
        pages.filter((p) => p === path),
        path,
      ).toHaveLength(1);
    for (const word of ["job = 'players'", "job = 'standings'", "from player_totals"])
      expect(
        queries.filter((q) => q.includes(word)),
        word,
      ).toHaveLength(1);
  });

  it("off-season: the rules that have an active window find nothing and the report says so", async () => {
    const server = await database(SYNCS);
    const { result } = await runStats(OFF_SEASON, {
      HARBOR_DB_URL: localUrl(server.port, "reader", PASSWORD),
    });
    // The forecast rule and the team-pages rule have no window, so they still look; the two windowed rules do not.
    expect(result.findings.filter((f) => f.checkId === "data-stale")).toEqual([]);
    expect(result.findings.filter((f) => f.checkId === "data-behind-source")).toEqual([]);
    const reasons = result.couldNotCheck.map((c) => `${c.id}: ${c.reason}`);
    expect(reasons).toContain(
      'data-stale: The rule "player-pages" only applies in October to June (it is July in America/New_York), so how old the stamp is was not checked.',
    );
    expect(reasons).toContain(
      'data-stale: The rule "standings" only applies in October to June (it is July in America/New_York), so how old the stamp is was not checked.',
    );
    expect(reasons).toContain(
      'data-behind-source: The rule "player-pages" only applies in October to June (it is July in America/New_York), so whether the page is behind its source was not checked.',
    );
    // Not passed: a check that looked at nothing has not passed.
    expect(result.passed).not.toContain("data-behind-source");
    // A rule without a window is unaffected.
    expect(result.findings.some((f) => f.checkId === "data-no-stamp")).toBe(true);
  });

  it("a database that is not set up is could not check, never a pass and never a finding", async () => {
    const { result } = await runStats(IN_SEASON, {});
    expect(result.findings.filter((f) => f.checkId === "data-behind-source")).toEqual([]);
    expect(result.passed).not.toContain("data-behind-source");
    const notes = result.couldNotCheck.filter((c) => c.id === "data-behind-source");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.some((n) => n.reason.includes("HARBOR_DB_URL"))).toBe(true);
    // The stamp checks need no database and still ran: the standings page is stale with an unknown source.
    const stale = result.findings.find((f) => f.checkId === "data-stale");
    expect(stale?.evidence).toContain(
      "could not be read, so whether the sync stopped is not known",
    );
  });

  it("never prints the password in any finding or note", async () => {
    const server = await database({});
    const { result } = await runStats(IN_SEASON, {
      HARBOR_DB_URL: localUrl(server.port, "reader", PASSWORD),
    });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });
});

describe("data freshness: the invented bar at 12:00 UTC on 10 November", () => {
  it("finds the old specials board and the trivia night still listed as coming up", async () => {
    const f = fixture("freshness-bar");
    const { result } = await checkSite({
      address: "https://juniper.example/",
      fetcher: network("juniper.example", f.dir, []),
      only: FRESHNESS_CHECKS,
      registry: createPageRegistry(),
      freshness: { config: f.freshness, env: {} },
      now: () => IN_SEASON,
    });
    expect(result.findings.map((x) => [x.checkId, x.url, x.evidence])).toEqual([
      [
        "data-stale",
        "https://juniper.example/specials",
        '/specials is stamped "2026-10-26" (at least 14 days ago), and weekly-specials allows 8 days.',
      ],
      [
        "forecast-for-past-event",
        "https://juniper.example/whats-on",
        '/whats-on lists 1 prediction whose event is already over (coming-up): "Thu Nov 5 Trivia night, 8pm" (2026-11-05).',
      ],
    ]);
  });
});
