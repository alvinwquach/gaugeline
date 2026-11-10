import { describe, expect, it } from "vitest";
import {
  MAX_ROWS,
  connectionVar,
  keyVar,
  queryParts,
  sourceEnvVars,
  sourcesConfigSchema,
} from "../config.js";

const ok = (sources: Record<string, unknown>): unknown => ({ sources });
const parse = (v: unknown) => sourcesConfigSchema.safeParse(v);

describe("gaugeline.sources.json", () => {
  it("reads a postgres and a supabase source, with the defaults", () => {
    const c = sourcesConfigSchema.parse(
      ok({
        db: {
          type: "postgres",
          queries: { eightySixed: "select name from menu_items where is_86" },
        },
        bar: { type: "supabase", queries: { q: { sql: "select 1" } } },
      }),
    );
    const db = c.sources.db!;
    const bar = c.sources.bar!;
    expect(connectionVar(db)).toBe("GAUGELINE_POSTGRES_URL");
    expect(keyVar(db)).toBeUndefined();
    expect(connectionVar(bar)).toBe("GAUGELINE_SUPABASE_DB_URL");
    expect(keyVar(bar)).toBe("GAUGELINE_SUPABASE_KEY");
    expect(sourceEnvVars(c).sort()).toEqual(
      ["GAUGELINE_POSTGRES_URL", "GAUGELINE_SUPABASE_DB_URL", "GAUGELINE_SUPABASE_KEY"].sort(),
    );
  });

  it("lets the file name other variables, and only names them", () => {
    const c = sourcesConfigSchema.parse(
      ok({
        db: { type: "supabase", env: "BUCK_DB", keyEnv: "BUCK_KEY", queries: { q: "select 1" } },
      }),
    );
    expect(sourceEnvVars(c)).toEqual(["BUCK_DB", "BUCK_KEY"]);
    // A value is not a name: a connection string pasted into env is refused, so a secret cannot sit in the file.
    expect(
      parse(ok({ db: { type: "postgres", env: "postgres://u:p@h/d", queries: { q: "select 1" } } }))
        .success,
    ).toBe(false);
  });

  it("turns a bare string and an object into the same shape", () => {
    expect(queryParts("select 1")).toEqual({ sql: "select 1" });
    expect(queryParts({ sql: "select 1" })).toEqual({ sql: "select 1" });
    const mapping = { kind: "text" as const, value: "name" };
    expect(queryParts({ sql: "select name", fact: mapping })).toEqual({
      sql: "select name",
      fact: mapping,
    });
  });

  it("defaults a price mapping to whole cents in dollars", () => {
    const c = sourcesConfigSchema.parse(
      ok({
        db: {
          type: "postgres",
          queries: {
            p: {
              sql: "select name, cents from t",
              fact: { kind: "price", item: "name", value: "cents" },
            },
          },
        },
      }),
    );
    expect(queryParts(c.sources.db!.queries.p!).fact).toMatchObject({
      unit: "minor",
      currency: "$",
    });
  });

  it.each([
    ["no sources", { sources: {} }],
    ["no queries", ok({ db: { type: "postgres", queries: {} } })],
    ["an unknown type", ok({ db: { type: "mysql", queries: { q: "select 1" } } })],
    [
      "an unknown key",
      ok({ db: { type: "postgres", url: "postgres://x", queries: { q: "select 1" } } }),
    ],
    [
      "a connection string in the file",
      ok({
        db: { type: "postgres", connectionString: "postgres://x", queries: { q: "select 1" } },
      }),
    ],
    [
      "a query name with a space",
      ok({ db: { type: "postgres", queries: { "86 list": "select 1" } } }),
    ],
    ["an empty query", ok({ db: { type: "postgres", queries: { q: "" } } })],
    [
      "a cap above 5,000",
      ok({ db: { type: "postgres", maxRows: MAX_ROWS + 1, queries: { q: "select 1" } } }),
    ],
    [
      "a timeout of an hour",
      ok({ db: { type: "postgres", timeoutMs: 3_600_000, queries: { q: "select 1" } } }),
    ],
    ["a timeout of 0", ok({ db: { type: "postgres", timeoutMs: 0, queries: { q: "select 1" } } })],
    [
      "a bad deny entry",
      ok({ db: { type: "postgres", denyFunctions: ["drop table"], queries: { q: "select 1" } } }),
    ],
    [
      "a fact with an unknown kind",
      ok({
        db: {
          type: "postgres",
          queries: { q: { sql: "select 1", fact: { kind: "hours", value: "x" } } },
        },
      }),
    ],
    ["a source name in capitals", ok({ DB: { type: "postgres", queries: { q: "select 1" } } })],
    [
      "a key variable that is lower case",
      ok({ db: { type: "supabase", keyEnv: "my_key", queries: { q: "select 1" } } }),
    ],
  ])("refuses %s", (_name, value) => {
    expect(parse(value).success).toBe(false);
  });

  it("refuses more than 5 sources and more than 50 queries", () => {
    const many = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        `s${i}`,
        { type: "postgres", queries: { q: "select 1" } },
      ]),
    );
    expect(parse(ok(many)).success).toBe(false);
    const queries = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`q${i}`, "select 1"]));
    expect(parse(ok({ db: { type: "postgres", queries } })).success).toBe(false);
  });
});
