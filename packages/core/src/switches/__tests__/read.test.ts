import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { useCassette } from "../../../../testkit/src/index.js";
import {
  startFakePostgres,
  type FakePostgres,
  type FakeReply,
} from "../../connectors/postgres/__tests__/fake-postgres.js";
import { localUrl } from "../../connectors/postgres/__tests__/helpers.js";
import { sourcesConfigSchema } from "../../connectors/postgres/config.js";
import { lazyDatabases } from "../../connectors/postgres/read.js";
import type { Env } from "../../connectors/types.js";
import { createFetcher, type Fetcher, type Transport } from "../../fetcher.js";
import { switchesConfigSchema } from "../config.js";
import { lazySwitches, readSwitches } from "../read.js";

const servers: FakePostgres[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const PASSWORD = ["bar", "pw", "0123456789"].join("-");
const TOKEN = ["sk", "sanity", "token", "0123456789abcdef"].join("_");
const SANITY: Env = { SANITY_PROJECT_ID: "mar1gold", SANITY_DATASET: "production" };

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function recorded(seen: Seen[] = []): Fetcher {
  const replay = useCassette("sanity-switches", { mode: "replay" });
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    return replay(url, req);
  };
  return createFetcher({ transport, timeoutMs: 5000 });
}

function serving(status: number, body: string): Fetcher {
  const transport: Transport = () =>
    Promise.resolve({
      status,
      headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.from(body, "utf8")]),
    });
  return createFetcher({ transport, timeoutMs: 5000 });
}

const config = (c: unknown) => switchesConfigSchema.parse(c);
const sw = (source: string, id = "preorders") => ({
  id,
  source,
  whenOff: { noLinksTo: ["/order"] },
});
const avail = (source: string, extra: Record<string, unknown> = {}) => ({
  source,
  mustNotAppearOn: ["/menu"],
  ...(source.startsWith("db:") ? { items: "name" } : {}),
  ...extra,
});
const cap = (source: string) => ({ source, whenZero: { pageSays: { "/order": "sold out" } } });
const same = (text: string) => text;

describe("reading switches from Sanity (recorded answers)", () => {
  it("reads true and false, and words like Closed, from published fields with one GET each", async () => {
    const seen: Seen[] = [];
    const read = await readSwitches(
      {
        config: config({
          switches: [
            sw("sanity:siteSettings.features.preOrders"),
            sw("sanity:siteSettings.features.walkUps", "walkups"),
            sw("sanity:siteSettings.features.closedFlag", "closed"),
          ],
        }),
        env: SANITY,
      },
      { fetcher: recorded(seen), redact: same },
    );
    expect(read.switches.map((s) => [s.id, s.state])).toEqual([
      ["preorders", "off"],
      ["walkups", "on"],
      ["closed", "off"],
    ]);
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET", "GET"]);
    for (const s of seen) {
      expect(s.url).toContain("perspective=published");
      expect(s.headers.authorization).toBeUndefined();
    }
  });

  it("a field read by two rules is asked once", async () => {
    const seen: Seen[] = [];
    await readSwitches(
      {
        config: config({
          switches: [
            sw("sanity:siteSettings.features.preOrders", "a"),
            sw("sanity:siteSettings.features.preOrders", "b"),
          ],
        }),
        env: SANITY,
      },
      { fetcher: recorded(seen), redact: same },
    );
    expect(seen).toHaveLength(1);
  });

  it("a field that is not set, or is not an on or off value, is unknown and says why", async () => {
    const read = await readSwitches(
      {
        config: config({
          switches: [
            sw("sanity:siteSettings.features.notSet", "unset"),
            sw("sanity:siteSettings.features.note", "note"),
            sw("sanity:noSuchType.x", "nodoc"),
          ],
        }),
        env: SANITY,
      },
      { fetcher: recorded(), redact: same },
    );
    const reasons = read.switches.map((s) => (s.state === "unknown" ? s.reason : "known"));
    expect(reasons[0]).toContain("is not set");
    expect(reasons[1]).toContain('gave "maybe later", which is not an on or off value');
    expect(reasons[2]).toContain("is not set");
  });

  it("with no SANITY_PROJECT_ID the rule is unknown, naming the variable, and nothing is requested", async () => {
    const seen: Seen[] = [];
    const read = await readSwitches(
      { config: config({ switches: [sw("sanity:siteSettings.features.preOrders")] }), env: {} },
      { fetcher: recorded(seen), redact: same },
    );
    expect(read.switches[0]).toMatchObject({ state: "unknown" });
    expect((read.switches[0] as { reason: string }).reason).toContain(
      "SANITY_PROJECT_ID is not set",
    );
    expect(seen).toEqual([]);
  });

  it("a private dataset (401) is unknown and says what key it needs", async () => {
    const read = await readSwitches(
      {
        config: config({ switches: [sw("sanity:siteSettings.features.preOrders")] }),
        env: { SANITY_PROJECT_ID: "pr1v4te0" },
      },
      { fetcher: recorded(), redact: same },
    );
    const reason = (read.switches[0] as { reason: string }).reason;
    expect(reason).toContain("refused the key (HTTP 401)");
    expect(reason).toContain("Viewer");
  });

  it("an unreachable Sanity (503), a rate limit and a non-answer are unknown, never a state", async () => {
    for (const [status, body] of [
      [503, "down"],
      [200, "not json"],
    ] as const) {
      const read = await readSwitches(
        {
          config: config({ switches: [sw("sanity:siteSettings.features.preOrders")] }),
          env: SANITY,
        },
        { fetcher: serving(status, body), redact: same },
      );
      expect(read.switches[0]?.state).toBe("unknown");
    }
    const limited = await readSwitches(
      { config: config({ switches: [sw("sanity:siteSettings.features.preOrders")] }), env: SANITY },
      { fetcher: serving(429, "slow down"), redact: same },
    );
    expect((limited.switches[0] as { reason: string }).reason).toContain("slow down");
  });

  it("a token never appears in a reason, even when the answer echoes it", async () => {
    const read = await readSwitches(
      {
        config: config({ switches: [sw("sanity:siteSettings.features.preOrders")] }),
        env: { ...SANITY, SANITY_TOKEN: TOKEN },
      },
      { fetcher: serving(200, `{"result":"${TOKEN}"}`), redact: same },
    );
    const reason = (read.switches[0] as { reason: string }).reason;
    expect(reason).not.toContain(TOKEN);
    expect(reason).toContain("[redacted]");
  });

  it("reads capacity as a whole number and refuses a word", async () => {
    const read = await readSwitches(
      {
        config: config({
          capacity: [
            { id: "zero", ...cap("sanity:siteSettings.capacity.remaining") },
            { id: "some", ...cap("sanity:siteSettings.capacity.left") },
            { id: "word", ...cap("sanity:siteSettings.capacity.bad") },
          ],
        }),
        env: SANITY,
      },
      { fetcher: recorded(), redact: same },
    );
    expect(read.capacity.map((c) => (c.state === "known" ? c.remaining : c.state))).toEqual([
      0,
      38,
      "unknown",
    ]);
  });

  it("reads a list of unavailable names; an unset list with the document there is empty, without it unknown", async () => {
    const read = await readSwitches(
      {
        config: config({
          availability: [
            { id: "list", ...avail("sanity:siteSettings.eightySixed") },
            { id: "empty", ...avail("sanity:siteSettings.emptyList") },
            { id: "nodoc", ...avail("sanity:noSuchType.eightySixed") },
            { id: "text", ...avail("sanity:siteSettings.notAList") },
          ],
        }),
        env: SANITY,
      },
      { fetcher: recorded(), redact: same },
    );
    const [list, empty, nodoc, text] = read.availability;
    expect(list).toMatchObject({ state: "known" });
    expect(list?.state === "known" ? list.items.map((i) => i.name) : []).toEqual([
      "Pozole rojo",
      "Tamales de rajas",
    ]);
    expect(empty).toMatchObject({ state: "known", items: [] });
    expect(nodoc?.state).toBe("unknown");
    expect(text).toMatchObject({ state: "unknown" });
    expect((text as { reason: string }).reason).toContain("is not a list of names");
  });
});

/** A stand-in Postgres whose named queries answer from `answers` by a word in the SQL. */
async function database(
  answers: Record<string, FakeReply>,
): Promise<{ server: FakePostgres; env: Env }> {
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
  return { server, env: { GAUGELINE_POSTGRES_URL: localUrl(server.port, "reader", PASSWORD) } };
}

const SOURCES = sourcesConfigSchema.parse({
  sources: {
    db: {
      type: "postgres",
      queries: {
        eightySixed: "select name from menu_items /* 86 */",
        tonightRemaining: "select left_over as value from tonight /* left */",
        flag: "select open as value from flags /* flag */",
      },
    },
  },
});

function viaDatabase(env: Env) {
  const fetcher = createFetcher({});
  return {
    fetcher,
    databases: { config: SOURCES, read: lazyDatabases({ config: SOURCES, env }, fetcher) },
    redact: same,
  };
}

describe("reading switches from named queries (stand-in Postgres)", () => {
  it("reads the 86 list, the number left and a flag, all inside the read-only layers", async () => {
    const { server, env } = await database({
      "/* 86 */": {
        columns: [{ name: "name" }],
        rows: [["Smash burgers"], ["Fried pickles"], [null], [""]],
      },
      "/* left */": { columns: [{ name: "value", oid: 23 }], rows: [["0"]] },
      "/* flag */": { columns: [{ name: "value", oid: 16 }], rows: [["f"]] },
    });
    const read = await readSwitches(
      {
        config: config({
          switches: [sw("db:flag")],
          availability: [avail("db:eightySixed")],
          capacity: [cap("db:tonightRemaining")],
        }),
        env: {},
      },
      viaDatabase(env),
    );
    expect(read.switches[0]).toMatchObject({ state: "off" });
    expect(read.capacity[0]).toMatchObject({ state: "known", remaining: 0 });
    const a = read.availability[0];
    expect(a?.state === "known" ? a.items.map((i) => i.name) : []).toEqual([
      "Smash burgers",
      "Fried pickles",
    ]);
    // Every statement ran after BEGIN READ ONLY, and nothing but the three reads and the role check was sent.
    const sent = server.received.map((r) => r.sql.trim().toLowerCase());
    expect(sent[0]).toMatch(/^begin.*read only/);
    expect(sent.filter((s) => /^(insert|update|delete|create|drop|alter)/.test(s))).toEqual([]);
  });

  it("a query that returns no rows or two rows is not a state", async () => {
    const { env } = await database({
      "/* flag */": { columns: [{ name: "value", oid: 16 }], rows: [] },
      "/* left */": { columns: [{ name: "value", oid: 23 }], rows: [["1"], ["2"]] },
    });
    const read = await readSwitches(
      {
        config: config({ switches: [sw("db:flag")], capacity: [cap("db:tonightRemaining")] }),
        env: {},
      },
      viaDatabase(env),
    );
    expect((read.switches[0] as { reason: string }).reason).toContain("returned no rows");
    expect((read.capacity[0] as { reason: string }).reason).toContain("returned 2 rows");
  });

  it("a query with two columns and none called value is not guessed at", async () => {
    const { env } = await database({
      "/* flag */": { columns: [{ name: "open" }, { name: "since" }], rows: [["t", "x"]] },
    });
    const read = await readSwitches(
      { config: config({ switches: [sw("db:flag")] }), env: {} },
      viaDatabase(env),
    );
    expect((read.switches[0] as { reason: string }).reason).toContain('"value"');
  });

  it("an 86 list whose column is not in the result is unknown, naming the columns it has", async () => {
    const { env } = await database({
      "/* 86 */": { columns: [{ name: "title" }], rows: [["Smash burgers"]] },
    });
    const read = await readSwitches(
      { config: config({ availability: [avail("db:eightySixed")] }), env: {} },
      viaDatabase(env),
    );
    expect((read.availability[0] as { reason: string }).reason).toContain(
      'does not return the column "name" (it returns title)',
    );
  });

  it("a query the database rejects is unknown with the connector's reason, never a pass", async () => {
    const { env } = await database({
      "/* left */": { error: { code: "42P01", message: 'relation "tonight" does not exist' } },
    });
    const read = await readSwitches(
      { config: config({ capacity: [cap("db:tonightRemaining")] }), env: {} },
      viaDatabase(env),
    );
    const c = read.capacity[0];
    expect(c?.state).toBe("unknown");
    expect((c as { reason: string }).reason).not.toContain(PASSWORD);
  });

  it("with the connection variable unset every db rule is unknown and says which variable to set", async () => {
    const read = await readSwitches(
      {
        config: config({
          switches: [sw("db:flag")],
          availability: [avail("db:eightySixed")],
          capacity: [cap("db:tonightRemaining")],
        }),
        env: {},
      },
      viaDatabase({}),
    );
    for (const r of [read.switches[0], read.availability[0], read.capacity[0]]) {
      expect(r?.state).toBe("unknown");
      expect((r as { reason: string }).reason).toContain("GAUGELINE_POSTGRES_URL");
    }
  });

  it("with no sources file a db rule is unknown", async () => {
    const read = await readSwitches(
      { config: config({ switches: [sw("db:flag")] }), env: {} },
      { fetcher: createFetcher({}), redact: same },
    );
    expect((read.switches[0] as { reason: string }).reason).toContain("no database source");
  });

  it("an item name from the database is escaped for printing, and a connection string in it is blanked", async () => {
    const name = `Pozole\u200B\u0007 ${PASSWORD}`;
    const { env } = await database({
      "/* 86 */": { columns: [{ name: "name" }], rows: [[name]] },
    });
    const sources = viaDatabase(env);
    const read = await readSwitches(
      { config: config({ availability: [avail("db:eightySixed")] }), env: {} },
      { ...sources, redact: (t) => t.split(PASSWORD).join("[redacted]") },
    );
    const a = read.availability[0];
    const item = a?.state === "known" ? a.items[0] : undefined;
    expect(item?.shown).toContain("\\u{200B}");
    expect(item?.shown).toContain("\\u{7}");
    expect(item?.shown).not.toContain(PASSWORD);
    // The raw name is kept for matching against the page.
    expect(item?.name).toContain(PASSWORD);
  });

  it("makes no connection at all until a check asks, and reads once however many ask", async () => {
    const { server, env } = await database({
      "/* flag */": { columns: [{ name: "value", oid: 16 }], rows: [["t"]] },
    });
    const sources = viaDatabase(env);
    const lazy = lazySwitches({ config: config({ switches: [sw("db:flag")] }), env: {} }, sources);
    expect(server.received).toEqual([]);
    const [a, b] = await Promise.all([lazy(), lazy()]);
    expect(a).toBe(b);
    expect(server.received.filter((r) => r.sql.includes("/* flag */"))).toHaveLength(1);
  });
});
