import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { staticSite, useCassette } from "../../../../testkit/src/index.js";
import {
  startFakePostgres,
  type FakePostgres,
  type FakeReply,
} from "../../connectors/postgres/__tests__/fake-postgres.js";
import { localUrl } from "../../connectors/postgres/__tests__/helpers.js";
import { sourcesConfigSchema } from "../../connectors/postgres/config.js";
import { createFetcher, type Fetcher, type Transport } from "../../fetcher.js";
import { createPageRegistry } from "../../checks/index.js";
import { SWITCH_CHECKS } from "../../presets.js";
import { checkSite } from "../../site.js";
import { switchesConfigSchema } from "../config.js";

const servers: FakePostgres[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const PASSWORD = ["pop", "pw", "0123456789"].join("-");

function fixture(name: string) {
  const dir = join(SITES_DIR, name);
  return {
    dir,
    switches: switchesConfigSchema.parse(
      JSON.parse(readFileSync(join(dir, "gaugeline.switches.json"), "utf8")),
    ),
    sources: sourcesConfigSchema.parse(
      JSON.parse(readFileSync(join(dir, "gaugeline.sources.json"), "utf8")),
    ),
  };
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

interface Seen {
  method: string;
  url: string;
}

function network(host: string, dir: string, seen: Seen[]): Fetcher {
  const inner = staticSite(host, dir, useCassette("sanity-switches", { mode: "replay" }));
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href });
    return inner(url, req);
  };
  return createFetcher({ transport, timeoutMs: 5000 });
}

describe("switches: the invented pop-up (switch off, 100-dish cap used up, one 86'd item)", () => {
  it("finds every way the site disagrees with the state behind it", async () => {
    const f = fixture("switches-popup");
    const server = await database({
      "from menu_items": {
        columns: [{ name: "name" }],
        rows: [["Pozole rojo"], ["Tamales de rajas"]],
      },
      "from pre_order_lines": { columns: [{ name: "value", oid: 23 }], rows: [["0"]] },
    });
    const env = { MARIGOLD_SUPABASE_DB_URL: localUrl(server.port, "gaugeline_reader", PASSWORD) };
    const seen: Seen[] = [];
    const result = await checkSite({
      address: "https://popup.example/",
      fetcher: network("popup.example", f.dir, seen),
      only: SWITCH_CHECKS,
      registry: createPageRegistry(),
      switches: { config: f.switches, env: { SANITY_PROJECT_ID: "mar1gold" } },
      databases: { config: f.sources, env },
    });
    const byCheck = (id: string) => result.result.findings.filter((x) => x.checkId === id);

    expect(byCheck("switch-off-still-linked").map((x) => [x.url, x.severity])).toEqual([
      ["https://popup.example/", "high"],
      ["https://popup.example/menu", "high"],
    ]);
    expect(byCheck("switch-off-still-linked")[0]?.evidence).toBe(
      'preorders is off (sanity:siteSettings.features.preOrders), but / still links to /order ("Pre-order", "pre-order for tonight").',
    );

    expect(byCheck("switch-page-wrong").map((x) => x.evidence)).toEqual([
      'preorders is off (sanity:siteSettings.features.preOrders), and /order does not say "order at the window".',
    ]);

    expect(byCheck("item-unavailable-shown").map((x) => [x.url, x.evidence])).toEqual([
      [
        "https://popup.example/menu",
        'db:eightySixed marks an item unavailable, but /menu still shows "Tamal de rajas" (the database has "Tamales de rajas").',
      ],
      [
        "https://popup.example/menu",
        'db:eightySixed marks an item unavailable, but the Menu structured data of /menu still has "Pozole rojo".',
      ],
    ]);

    expect(byCheck("capacity-zero-not-sold-out").map((x) => x.evidence)).toEqual([
      'db:tonightRemaining has 0 left, and /order does not say "sold out"; it still has an order form.',
    ]);

    expect(result.result.couldNotCheck).toEqual([]);
    expect(result.result.failed).toEqual([]);
  });

  it("reads only: GET requests to the site and to Sanity, a read-only transaction to the database", async () => {
    const f = fixture("switches-popup");
    const server = await database({
      "from menu_items": { columns: [{ name: "name" }], rows: [] },
      "from pre_order_lines": { columns: [{ name: "value", oid: 23 }], rows: [["5"]] },
    });
    const seen: Seen[] = [];
    await checkSite({
      address: "https://popup.example/",
      fetcher: network("popup.example", f.dir, seen),
      only: SWITCH_CHECKS,
      registry: createPageRegistry(),
      switches: { config: f.switches, env: { SANITY_PROJECT_ID: "mar1gold" } },
      databases: {
        config: f.sources,
        env: { MARIGOLD_SUPABASE_DB_URL: localUrl(server.port, "gaugeline_reader", PASSWORD) },
      },
    });
    expect(seen.length).toBeGreaterThan(3);
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET"]));
    const sent = server.received.map((r) => r.sql.trim().toLowerCase());
    expect(sent[0]).toMatch(/^begin.*read only/);
    expect(sent.some((s) => /^(insert|update|delete|create|drop|alter|truncate)/.test(s))).toBe(
      false,
    );
  });

  it("every source down: each rule is could not check with its reason, and there is no finding and no pass", async () => {
    const f = fixture("switches-popup");
    const seen: Seen[] = [];
    const result = await checkSite({
      address: "https://popup.example/",
      fetcher: network("popup.example", f.dir, seen),
      only: SWITCH_CHECKS,
      registry: createPageRegistry(),
      // No SANITY_PROJECT_ID and no connection string.
      switches: { config: f.switches, env: {} },
      databases: { config: f.sources, env: {} },
    });
    expect(result.result.findings).toEqual([]);
    expect(result.result.passed).toEqual([]);
    const reasons = new Map(result.result.couldNotCheck.map((c) => [c.id, c.reason]));
    expect([...reasons.keys()].sort()).toEqual([...SWITCH_CHECKS].sort());
    expect(reasons.get("switch-off-still-linked")).toContain("SANITY_PROJECT_ID is not set");
    expect(reasons.get("item-unavailable-shown")).toContain("MARIGOLD_SUPABASE_DB_URL");
    expect(reasons.get("capacity-zero-not-sold-out")).toContain("MARIGOLD_SUPABASE_DB_URL");
    // Nothing but the site itself was requested: no source, so no request to one.
    expect(seen.every((s) => s.url.startsWith("https://popup.example/"))).toBe(true);
  });

  it("when the site follows the state, every check passes", async () => {
    const f = fixture("switches-popup");
    const server = await database({
      "from menu_items": { columns: [{ name: "name" }], rows: [["Soup that is not on the menu"]] },
      "from pre_order_lines": { columns: [{ name: "value", oid: 23 }], rows: [["30"]] },
    });
    // Pre-orders on (the walk-ups answer in the recording is true), the page says what it should.
    const on = {
      ...f.switches,
      switches: [
        {
          ...(f.switches.switches?.[0] as object),
          id: "walkups",
          source: "sanity:siteSettings.features.walkUps",
        },
      ],
    } as typeof f.switches;
    const result = await checkSite({
      address: "https://popup.example/",
      fetcher: network("popup.example", f.dir, []),
      only: SWITCH_CHECKS,
      registry: createPageRegistry(),
      switches: { config: on, env: { SANITY_PROJECT_ID: "mar1gold" } },
      databases: {
        config: f.sources,
        env: { MARIGOLD_SUPABASE_DB_URL: localUrl(server.port, "gaugeline_reader", PASSWORD) },
      },
    });
    expect(result.result.findings).toEqual([]);
    expect(result.result.couldNotCheck).toEqual([]);
    expect([...result.result.passed].sort()).toEqual([...SWITCH_CHECKS].sort());
  });

  it("without gaugeline.switches.json the four checks are not run at all (neither passed nor failed)", async () => {
    const f = fixture("switches-popup");
    const result = await checkSite({
      address: "https://popup.example/",
      fetcher: network("popup.example", f.dir, []),
      registry: createPageRegistry(),
    });
    for (const id of SWITCH_CHECKS) {
      expect(result.result.passed).not.toContain(id);
      expect(result.result.findings.map((x) => x.checkId)).not.toContain(id);
    }
  });

  it("said by id with no file, a check says it could not check", async () => {
    const f = fixture("switches-popup");
    const result = await checkSite({
      address: "https://popup.example/",
      fetcher: network("popup.example", f.dir, []),
      registry: createPageRegistry(),
      only: ["switch-page-wrong"],
    });
    expect(result.result.couldNotCheck.map((c) => c.id)).toEqual(["switch-page-wrong"]);
  });
});

describe("switches: the invented bar (86 list with different spellings)", () => {
  it("finds an 86'd item on the menu page and in the Menu structured data, and none on the clean page", async () => {
    const f = fixture("switches-bar");
    const server = await database({
      "from kitchen_items": {
        columns: [{ name: "name" }],
        rows: [["Fried pickles"], ["Smash burgers"]],
      },
    });
    const result = await checkSite({
      address: "https://lantern.example/",
      fetcher: network("lantern.example", f.dir, []),
      only: ["item-unavailable-shown"],
      registry: createPageRegistry(),
      switches: { config: f.switches, env: {} },
      databases: {
        config: f.sources,
        env: { LANTERN_SUPABASE_DB_URL: localUrl(server.port, "gaugeline_reader", PASSWORD) },
      },
    });
    expect(result.result.findings.map((x) => [x.url, x.evidence])).toEqual([
      [
        "https://lantern.example/menu",
        'eighty-six (db:eightySixed) marks 2 items unavailable, but /menu still shows "Fried pickles", "Smash Burger" (the database has "Smash burgers").',
      ],
      [
        "https://lantern.example/menu",
        'eighty-six (db:eightySixed) marks an item unavailable, but the Menu structured data of /menu still has "Smash burger" (the database has "Smash burgers").',
      ],
    ]);
  });
});
