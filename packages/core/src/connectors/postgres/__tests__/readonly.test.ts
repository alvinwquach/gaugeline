import { afterEach, describe, expect, it } from "vitest";
import { DatabaseError } from "../failure.js";
import { databaseConnector } from "../connector.js";
import { ReadOnlySession } from "../session.js";
import { parseConnectionString } from "../url.js";
import { createFetcher } from "../../../fetcher.js";
import { startFakePostgres, type FakePostgres } from "./fake-postgres.js";
import { DB_VAR, localUrl, runSource, source } from "./helpers.js";

const servers: FakePostgres[] = [];
async function fake(options: Parameters<typeof startFakePostgres>[0] = {}): Promise<FakePostgres> {
  const s = await startFakePostgres(options);
  servers.push(s);
  return s;
}
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const rows = (n: number): string[][] => Array.from({ length: n }, (_, i) => [String(i + 1)]);
const ids = { columns: [{ name: "n", oid: 23 }] };

describe("a SELECT, seen from the socket", () => {
  it("is sent inside BEGIN READ ONLY with a statement timeout, as an extended-protocol query, and rolled back", async () => {
    const server = await fake({
      onQuery: (sql) =>
        sql.startsWith("select name")
          ? { columns: [{ name: "name" }], rows: [["Negroni"], ["Old Fashioned"]] }
          : undefined,
    });
    const { results } = await runSource(
      source({
        type: "postgres",
        queries: { eightySixed: "select name from menu_items where is_86 = true" },
      }),
      { [DB_VAR]: localUrl(server.port) },
    );
    expect(results).toEqual([
      expect.objectContaining({
        query: "eightySixed",
        status: "ok",
        columns: ["name"],
        rows: [{ name: "Negroni" }, { name: "Old Fashioned" }],
        truncated: false,
      }),
    ]);
    const sent = server.received.map((r) => r.sql);
    const at = sent.indexOf("select name from menu_items where is_86 = true");
    expect(at).toBeGreaterThan(0);
    // Everything before the query: the transaction is read-only before the query can run.
    expect(sent.slice(0, at)).toEqual([
      "begin read only",
      "set local statement_timeout = 5000",
      "set local idle_in_transaction_session_timeout = 30000",
      "set local standard_conforming_strings = on",
      "show transaction_read_only",
    ]);
    expect(sent[at + 1]).toBe("rollback");
    expect(server.received[at]?.protocol).toBe("extended");
    // Nothing was ever committed.
    expect(sent.filter((s) => /^commit|^end\b/i.test(s))).toEqual([]);
  });

  it("starts the session with the user, a database and the application name, and nothing that could switch read-only off", async () => {
    const server = await fake();
    await runSource(source({ type: "postgres", queries: { q: "select 1" } }), {
      [DB_VAR]: localUrl(server.port),
    });
    expect(server.startup).toMatchObject({
      user: "reader",
      database: "bar",
      application_name: "gaugeline",
    });
    expect(Object.keys(server.startup).sort()).toEqual(
      ["application_name", "client_encoding", "database", "user"].sort(),
    );
  });

  it("sends the timeout the config sets", async () => {
    const server = await fake();
    await runSource(source({ type: "postgres", timeoutMs: 1500, queries: { q: "select 1" } }), {
      [DB_VAR]: localUrl(server.port),
    });
    expect(server.received.map((r) => r.sql)).toContain("set local statement_timeout = 1500");
  });
});

describe("what never reaches the server (layer 1, the classifier)", () => {
  const attempts: Record<string, string> = {
    insert: "insert into bookings (name) values ('x')",
    update: "update bookings set party_size = 0",
    delete: "delete from bookings",
    ddl: "drop table bookings",
    "create table as": "create table copy_of_bookings as select * from bookings",
    copy: "copy bookings to program 'curl http://example.test'",
    "two statements": "select 1; select 2",
    "semicolon smuggling": "select 'x'; delete from bookings; --'",
    "backslash smuggling": "select '\\'; delete from bookings; --'",
    "comment-obfuscated": "with x as (/**/delete/**/ from bookings returning 1) select 1",
    "comment hides a semicolon": "select 1 /**/;/**/ update bookings set party_size = 0",
    "data-modifying CTE": "with d as (delete from bookings returning *) select * from d",
    "select into": "select * into backup_bookings from bookings",
    "locking clause": "select * from bookings for update",
    "terminate a session": "select pg_terminate_backend(pid) from pg_stat_activity",
    "change a setting": "select set_config('default_transaction_read_only', 'off', false)",
    "import a file": "select lo_import('/etc/passwd')",
    "read a file": "select pg_read_file('/etc/passwd')",
    "wait forever": "select pg_sleep(3600)",
    "take a sequence value": "select nextval('bookings_id_seq')",
    "call another database": "select * from dblink('host=elsewhere', 'select 1') as t(a int)",
  };

  it.each(Object.entries(attempts))(
    "%s is refused before it is sent, and the run goes on",
    async (_name, sql) => {
      const server = await fake();
      const { results, run } = await runSource(
        source({ type: "postgres", queries: { bad: sql, good: "select 1 as n" } }),
        { [DB_VAR]: localUrl(server.port) },
      );
      expect(results[0]).toMatchObject({ query: "bad", status: "could-not-check", rows: [] });
      expect(results[0]?.message).toMatch(/was not sent/);
      expect(results[1]).toMatchObject({ query: "good", status: "ok" });
      // The statement itself is nowhere in what the socket saw.
      const flat = server.received.map((r) => r.sql).join("\n");
      expect(flat).not.toContain(sql);
      expect(flat).not.toMatch(
        /bookings|pg_terminate|set_config|lo_import|pg_read_file|pg_sleep|nextval|dblink/,
      );
      expect(run.notices.filter((n) => n.kind !== "advice")).toEqual([]);
    },
  );

  it("does not even open a connection when every query is refused", async () => {
    const server = await fake();
    const { results } = await runSource(
      source({ type: "postgres", queries: { a: "delete from bookings", b: "select 1; select 2" } }),
      { [DB_VAR]: localUrl(server.port) },
    );
    expect(results.map((r) => r.status)).toEqual(["could-not-check", "could-not-check"]);
    expect(server.received).toEqual([]);
    expect(server.startup).toEqual({});
  });

  it("applies the config's own deny list too", async () => {
    const server = await fake();
    const { results } = await runSource(
      source({
        type: "postgres",
        denyFunctions: ["log_visit"],
        queries: { q: "select log_visit(1)" },
      }),
      { [DB_VAR]: localUrl(server.port) },
    );
    expect(results[0]?.status).toBe("could-not-check");
    expect(server.received).toEqual([]);
  });
});

describe("if the classifier were bypassed (layer 2, the read-only transaction)", () => {
  it("a write called straight on the session still goes inside BEGIN READ ONLY, and its failure is reported as a refused write", async () => {
    const server = await fake({
      onQuery: (sql) =>
        sql.startsWith("update")
          ? {
              error: { code: "25006", message: "cannot execute UPDATE in a read-only transaction" },
            }
          : undefined,
    });
    const parsed = parseConnectionString(localUrl(server.port), {});
    if (!parsed.ok) throw new Error("setup");
    const session = new ReadOnlySession(parsed.value);
    await expect(
      session.runUnchecked("update bookings set party_size = 0", {
        statementTimeoutMs: 1000,
        maxRows: 10,
      }),
    ).rejects.toMatchObject({ code: "25006" });
    await session.close();
    const sent = server.received.map((r) => r.sql);
    expect(sent[0]).toBe("begin read only");
    expect(sent.indexOf("update bookings set party_size = 0")).toBeGreaterThan(
      sent.indexOf("show transaction_read_only"),
    );
    expect(sent.at(-1)).toBe("rollback");
  });

  it("sends nothing when the server does not confirm a read-only transaction", async () => {
    const server = await fake({ readOnlyAnswer: "off" });
    await expect(
      runSource(source({ type: "postgres", queries: { q: "select 1" } }), {
        [DB_VAR]: localUrl(server.port),
      }),
    ).resolves.toMatchObject({
      run: {
        notices: [
          expect.objectContaining({
            kind: "unreachable",
            message: expect.stringMatching(/read-only transaction/),
          }),
        ],
      },
    });
    expect(server.received.map((r) => r.sql)).not.toContain("select 1");
    expect(server.received.map((r) => r.sql).at(-1)).toBe("rollback");
  });
});

describe("limits", () => {
  it("keeps 5,000 rows of 6,000, says so in the result and as an advice notice, and reads no more than it needs", async () => {
    const server = await fake({
      onQuery: (sql) => (sql === "select n from big" ? { ...ids, rows: rows(6000) } : undefined),
    });
    const { results, run } = await runSource(
      source({ type: "postgres", queries: { big: "select n from big" } }),
      { [DB_VAR]: localUrl(server.port) },
    );
    expect(results[0]?.rows).toHaveLength(5000);
    expect(results[0]?.rows[4999]).toEqual({ n: 5000 });
    expect(results[0]).toMatchObject({ truncated: true, status: "ok" });
    expect(results[0]?.message).toBe(
      'The query "big" returned more than 5,000 rows; only the first 5,000 were used.',
    );
    expect(run.notices).toContainEqual({
      connector: "db:db",
      kind: "advice",
      message: results[0]?.message,
    });
  });

  it("does not report exactly 5,000 rows as truncated", async () => {
    const server = await fake({
      onQuery: (sql) => (sql === "select n from big" ? { ...ids, rows: rows(5000) } : undefined),
    });
    const { results } = await runSource(
      source({ type: "postgres", queries: { big: "select n from big" } }),
      {
        [DB_VAR]: localUrl(server.port),
      },
    );
    expect(results[0]).toMatchObject({ truncated: false });
    expect(results[0]?.rows).toHaveLength(5000);
  });

  it("lets a config lower the cap but not raise it", async () => {
    const server = await fake({
      onQuery: (sql) => (sql === "select n from big" ? { ...ids, rows: rows(50) } : undefined),
    });
    const { results } = await runSource(
      source({ type: "postgres", maxRows: 10, queries: { big: "select n from big" } }),
      { [DB_VAR]: localUrl(server.port) },
    );
    expect(results[0]?.rows).toHaveLength(10);
    expect(results[0]?.truncated).toBe(true);
    expect(() => source({ type: "postgres", maxRows: 5001, queries: { q: "select 1" } })).toThrow();
  });

  it("a query the database stops for taking too long is could-not-check and the next query still runs", async () => {
    const server = await fake({
      onQuery: (sql) =>
        sql === "select slow"
          ? { error: { code: "57014", message: "canceling statement due to statement timeout" } }
          : sql === "select n from fast"
            ? { ...ids, rows: rows(2) }
            : undefined,
    });
    const { results, run } = await runSource(
      source({ type: "postgres", queries: { slow: "select slow", fast: "select n from fast" } }),
      { [DB_VAR]: localUrl(server.port) },
    );
    expect(results[0]).toMatchObject({ query: "slow", status: "could-not-check" });
    expect(results[0]?.message).toMatch(/longer than the statement timeout/);
    expect(results[1]).toMatchObject({ query: "fast", status: "ok", rows: [{ n: 1 }, { n: 2 }] });
    expect(run.notices.filter((n) => n.kind !== "advice")).toEqual([]);
    // Each query got its own transaction, and both were rolled back.
    expect(server.received.filter((r) => r.sql === "begin read only")).toHaveLength(3);
    expect(server.received.filter((r) => r.sql === "rollback")).toHaveLength(3);
  });
});

describe("typed failures, each a plain message", () => {
  it("connection refused", async () => {
    const server = await fake();
    const port = server.port;
    await server.close();
    const { run, results } = await runSource(
      source({ type: "postgres", queries: { q: "select 1" } }),
      {
        [DB_VAR]: localUrl(port),
      },
    );
    expect(results).toEqual([]);
    expect(run.notices).toEqual([
      expect.objectContaining({
        kind: "unreachable",
        message: expect.stringContaining(`Could not connect to the database at 127.0.0.1:${port}`),
      }),
    ]);
  });

  it("wrong password", async () => {
    const password = "hunter2-0123456789";
    const server = await fake({
      startupError: { code: "28P01", message: `password authentication failed for user "reader"` },
    });
    const { run } = await runSource(source({ type: "postgres", queries: { q: "select 1" } }), {
      [DB_VAR]: localUrl(server.port, "reader", password),
    });
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]?.message).toMatch(/refused the user name or password/);
    expect(JSON.stringify(run.notices)).not.toContain(password);
  });

  it("the server requires encryption", async () => {
    const server = await fake({
      startupError: {
        code: "28000",
        message:
          'no pg_hba.conf entry for host "10.0.0.1", user "reader", database "bar", no encryption',
      },
    });
    const { run } = await runSource(source({ type: "postgres", queries: { q: "select 1" } }), {
      [DB_VAR]: localUrl(server.port),
    });
    expect(run.notices[0]?.message).toMatch(/requires an encrypted connection.*sslmode=require/);
  });

  it("the server has no TLS but the address asks for it", async () => {
    const server = await fake();
    const url = localUrl(server.port).replace("sslmode=disable", "sslmode=require");
    const { run } = await runSource(source({ type: "postgres", queries: { q: "select 1" } }), {
      [DB_VAR]: url,
    });
    expect(server.sawTlsRequest).toBe(true);
    expect(run.notices[0]?.message).toMatch(
      /did not accept an encrypted connection.*sslmode=disable/,
    );
  });

  it("a connection string that is not one is a plain message that does not repeat it", async () => {
    const { run } = await runSource(source({ type: "postgres", queries: { q: "select 1" } }), {
      [DB_VAR]: "hunter2-this-is-not-a-url",
    });
    expect(run.notices[0]?.message).toMatch(/not a postgres:\/\/ address/);
    expect(JSON.stringify(run.notices)).not.toContain("hunter2");
  });

  it("a key or password inside the driver's own error message is redacted", async () => {
    const password = "hunter2-0123456789";
    const key = ["eyJhbGciOiJIUzI1NiJ9", "eyJyb2xlIjoiYW5vbiJ9", "c2ln"].join(".");
    const server = await fake({
      onQuery: () => ({
        error: {
          code: "42P01",
          message: `relation "t" does not exist (user=reader password=${password} key=${key})`,
        },
      }),
    });
    const { results, run } = await runSource(
      source({
        type: "supabase",
        env: "BAR_DB",
        keyEnv: "BAR_KEY",
        queries: { q: "select * from t" },
      }),
      { BAR_DB: localUrl(server.port, "bar_reader", password), BAR_KEY: key },
    );
    const all = JSON.stringify({ results, notices: run.notices });
    expect(all).not.toContain(password);
    expect(all).not.toContain(key);
    expect(results[0]?.status).toBe("could-not-check");
    expect(results[0]?.message).toContain("[redacted]");
  });
});

describe("a database is not a site: the fetcher is never touched", () => {
  it("read() ignores the fetcher", async () => {
    const server = await fake();
    const connector = databaseConnector(
      "db",
      source({ type: "postgres", queries: { q: "select 1" } }),
    );
    const rowsOut = await connector.read({ [DB_VAR]: localUrl(server.port) }, createFetcher({}));
    expect(rowsOut).toHaveLength(1);
  });

  it("is configured only when the connection variable is set and non-empty", () => {
    const connector = databaseConnector(
      "db",
      source({ type: "postgres", queries: { q: "select 1" } }),
    );
    expect(connector.configured({})).toBe(false);
    expect(connector.configured({ [DB_VAR]: "" })).toBe(false);
    expect(connector.configured({ [DB_VAR]: "postgres://u@h/d" })).toBe(true);
    expect(connector.secretEnvVars).toEqual([DB_VAR]);
  });

  it("the runner says which variable to set when it is missing", async () => {
    const { run } = await runSource(source({ type: "postgres", queries: { q: "select 1" } }), {});
    expect(run.notices[0]).toMatchObject({ kind: "not-configured" });
    expect(run.notices[0]?.message).toContain(DB_VAR);
  });
});

describe("Supabase", () => {
  const jwt = (role: string): string =>
    [{ alg: "HS256" }, { role }, "c2ln"]
      .map((p) =>
        typeof p === "string" ? p : Buffer.from(JSON.stringify(p)).toString("base64url"),
      )
      .join(".");

  it("refuses a service_role key before connecting, without printing the key", async () => {
    const server = await fake();
    const key = jwt("service_role");
    const { run, results } = await runSource(
      source({ type: "supabase", queries: { q: "select 1" } }),
      {
        GAUGELINE_SUPABASE_DB_URL: localUrl(server.port, "bar_reader"),
        GAUGELINE_SUPABASE_KEY: key,
      },
    );
    expect(results).toEqual([]);
    expect(run.notices[0]?.message).toMatch(/service_role/);
    expect(JSON.stringify(run.notices)).not.toContain(key);
    expect(JSON.stringify(run.notices)).not.toContain(key.split(".")[1]);
    expect(server.received).toEqual([]);
    expect(server.startup).toEqual({});
  });

  it("accepts the anon key and a connection as a role the owner made", async () => {
    const server = await fake();
    const { results } = await runSource(source({ type: "supabase", queries: { q: "select 1" } }), {
      GAUGELINE_SUPABASE_DB_URL: localUrl(server.port, "bar_reader"),
      GAUGELINE_SUPABASE_KEY: jwt("anon"),
    });
    expect(results[0]?.status).toBe("ok");
  });

  it("works with no key set: the connection string is what connects", async () => {
    const server = await fake();
    const { results } = await runSource(source({ type: "supabase", queries: { q: "select 1" } }), {
      GAUGELINE_SUPABASE_DB_URL: localUrl(server.port, "bar_reader"),
    });
    expect(results[0]?.status).toBe("ok");
  });

  it.each(["postgres", "service_role", "supabase_admin", "postgres.abcdefghijklmnop"])(
    "refuses to connect as %s, which reads around row-level security",
    async (user) => {
      const server = await fake();
      const { run } = await runSource(source({ type: "supabase", queries: { q: "select 1" } }), {
        GAUGELINE_SUPABASE_DB_URL: localUrl(server.port, user),
      });
      expect(run.notices[0]?.message).toMatch(/row-level security/);
      expect(server.received).toEqual([]);
    },
  );

  it("a plain postgres source may use any user (its role is the owner's business, and gets advice instead)", async () => {
    const server = await fake();
    const { results } = await runSource(source({ type: "postgres", queries: { q: "select 1" } }), {
      [DB_VAR]: localUrl(server.port, "postgres"),
    });
    expect(results[0]?.status).toBe("ok");
  });
});

describe("advice about the role", () => {
  it("says so when the role can write or bypass row-level security", async () => {
    const server = await fake({
      onQuery: (sql) =>
        sql.startsWith("select current_user")
          ? { columns: [{ name: "role" }, { name: "strong", oid: 16 }], rows: [["postgres", "t"]] }
          : undefined,
    });
    const { run } = await runSource(source({ type: "postgres", queries: { q: "select 1" } }), {
      [DB_VAR]: localUrl(server.port, "postgres"),
    });
    const advice = run.notices.filter((n) => n.kind === "advice");
    expect(advice).toHaveLength(1);
    expect(advice[0]?.message).toMatch(/postgres, a role that can write/);
    expect(advice[0]?.message).toMatch(/docs\/connectors\/postgres/);
  });

  it("stays quiet for a read-only role", async () => {
    const server = await fake({
      onQuery: (sql) =>
        sql.startsWith("select current_user")
          ? { columns: [{ name: "role" }, { name: "strong", oid: 16 }], rows: [["reader", "f"]] }
          : undefined,
    });
    const { run } = await runSource(source({ type: "postgres", queries: { q: "select 1" } }), {
      [DB_VAR]: localUrl(server.port),
    });
    expect(run.notices.filter((n) => n.kind === "advice")).toEqual([]);
  });
});

it("DatabaseError carries its kind", () => {
  const e = new DatabaseError({ kind: "auth", message: "x" });
  expect(e.kind).toBe("auth");
});
