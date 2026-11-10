import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENIED_FUNCTIONS,
  MAX_STATEMENT_CHARS,
  classifyStatement,
  type RefusalReason,
} from "../classify.js";

interface SharedCase {
  id: string;
  sql: string;
  expect: "allow" | "refuse";
  family: string;
}

const shared = JSON.parse(
  readFileSync(fileURLToPath(new URL("../classifier-cases.json", import.meta.url)), "utf8"),
) as { version: number; cases: SharedCase[] };

/** What a person means by a family, as the reasons the classifier may give for it. */
const REASONS: Record<string, RefusalReason[]> = {
  write: ["write"],
  statement: ["not-select", "write"],
  multiple: ["multiple", "syntax"],
  into: ["into"],
  locking: ["locking"],
  syntax: ["syntax"],
  function: ["function"],
  empty: ["empty"],
};

describe("the shared case list (packages/core/src/connectors/postgres/classifier-cases.json)", () => {
  it("is versioned, has unique ids and covers both verdicts", () => {
    expect(shared.version).toBe(1);
    const ids = shared.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(shared.cases.some((c) => c.expect === "allow")).toBe(true);
    expect(shared.cases.some((c) => c.expect === "refuse")).toBe(true);
    for (const family of new Set(shared.cases.map((c) => c.family)))
      expect(family === "read" || REASONS[family] !== undefined, family).toBe(true);
  });

  it.each(shared.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const verdict = classifyStatement(c.sql);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(c.expect === "allow");
    if (!verdict.ok) {
      expect(REASONS[c.family], `${c.id}: family ${c.family}`).toContain(verdict.reason);
      expect(verdict.message.length).toBeGreaterThan(10);
    }
  });
});

describe("classifyStatement: what is allowed", () => {
  it("accepts a SELECT and a WITH ... SELECT and returns the statement without a trailing semicolon", () => {
    expect(classifyStatement("select 1;")).toEqual({ ok: true, sql: "select 1" });
    const cte = classifyStatement("with a as (select 1 as n) select n from a");
    expect(cte).toEqual({ ok: true, sql: "with a as (select 1 as n) select n from a" });
  });

  it("keeps the text the caller wrote, apart from the final semicolon, so the server sees what was checked", () => {
    const sql = "select /* keep */ 'a;b' as s -- tail\n";
    expect(classifyStatement(sql)).toEqual({ ok: true, sql });
    expect(classifyStatement(`${sql};`)).toEqual({ ok: true, sql });
  });
});

describe("classifyStatement: what is refused, with a message that helps", () => {
  it("names the keyword for a write and says what to do", () => {
    const v = classifyStatement("delete from bookings");
    expect(v).toMatchObject({ ok: false, reason: "write" });
    expect(v.ok ? "" : v.message).toMatch(/DELETE/);
    expect(v.ok ? "" : v.message).toMatch(/only reads/i);
  });

  it("says a data-modifying CTE is a write even though the statement starts with WITH", () => {
    const v = classifyStatement("with d as (delete from t returning *) select * from d");
    expect(v).toMatchObject({ ok: false, reason: "write" });
  });

  it("tells a person with a column called like a keyword to quote it", () => {
    const v = classifyStatement("select update from t");
    expect(v.ok).toBe(false);
    expect(v.ok ? "" : v.message).toMatch(/double quotes/);
  });

  it("never repeats the text of a string in the message (it may be someone's data)", () => {
    const v = classifyStatement(
      `select '${["ada.lovelace", "example.test"].join("@")}' ; delete from t`,
    );
    expect(v.ok).toBe(false);
    expect(v.ok ? "" : v.message).not.toContain("ada.lovelace");
  });

  it("refuses a statement longer than the limit before reading it", () => {
    const sql = `select ${"1 + ".repeat(MAX_STATEMENT_CHARS)}1`;
    expect(classifyStatement(sql)).toMatchObject({ ok: false, reason: "too-long" });
  });

  it("refuses something that is not text", () => {
    expect(classifyStatement(undefined as unknown as string)).toMatchObject({
      ok: false,
      reason: "empty",
    });
  });
});

describe("classifyStatement: the deny list of functions", () => {
  it("lists every default entry in lower case, with no duplicates", () => {
    expect(new Set(DEFAULT_DENIED_FUNCTIONS).size).toBe(DEFAULT_DENIED_FUNCTIONS.length);
    for (const name of DEFAULT_DENIED_FUNCTIONS) expect(name).toBe(name.toLowerCase());
    for (const name of [
      "pg_terminate_backend",
      "set_config",
      "lo_*",
      "pg_sleep",
      "nextval",
      "dblink*",
    ])
      expect(DEFAULT_DENIED_FUNCTIONS).toContain(name);
  });

  it.each([...DEFAULT_DENIED_FUNCTIONS])("refuses %s", (entry) => {
    const name = entry.endsWith("*") ? `${entry.slice(0, -1)}_x` : entry;
    const v = classifyStatement(`select ${name}(1)`);
    expect(v).toMatchObject({ ok: false, reason: "function" });
    expect(v.ok ? "" : v.message).toContain(name);
  });

  it("matches a name in any case and from a quoted identifier", () => {
    expect(classifyStatement("select PG_TERMINATE_BACKEND(1)").ok).toBe(false);
    expect(classifyStatement('select "PG_TERMINATE_BACKEND"(1)').ok).toBe(false);
    expect(classifyStatement('select pg_catalog."pg_terminate_backend"(1)').ok).toBe(false);
  });

  it("does not refuse a name that only starts or ends like a denied one", () => {
    expect(classifyStatement("select next_valid_date from t").ok).toBe(true);
    expect(classifyStatement("select my_set_config_flag from t").ok).toBe(true);
    expect(classifyStatement("select 1 as lo").ok).toBe(true);
  });

  it("adds the names a config lists, as exact names or with a trailing star", () => {
    const options = { denyFunctions: ["log_visit", "audit_*"] };
    expect(classifyStatement("select log_visit(1)", options)).toMatchObject({
      ok: false,
      reason: "function",
    });
    expect(classifyStatement("select audit_write(1)", options)).toMatchObject({
      ok: false,
      reason: "function",
    });
    expect(classifyStatement("select log_visits from t", options).ok).toBe(true);
    // The defaults still apply.
    expect(classifyStatement("select set_config('a', 'b', false)", options).ok).toBe(false);
  });
});

describe("classifyStatement: edge cases that tried to get past an earlier classifier", () => {
  const writes = [
    "insert into t values (1)",
    "update t set a = 1",
    "delete from t",
    "with x as (delete from t returning 1) select 1",
  ];

  it("refuses every write however it is cased, spaced or commented", () => {
    for (const sql of writes) {
      const variants = [
        sql,
        sql.toUpperCase(),
        sql.replace(/ /g, "\n"),
        sql.replace(/ /g, "\t"),
        sql.replace(/ /g, "/**/ /**/"),
        `/* lead */ ${sql}`,
        `-- lead\n${sql}`,
        `${sql} -- tail`,
        sql.replace(/\b(insert|update|delete)\b/g, (w) => w[0]!.toUpperCase() + w.slice(1)),
      ];
      for (const v of variants) expect(classifyStatement(v).ok, JSON.stringify(v)).toBe(false);
    }
  });

  it("treats a comment as a gap between words, never as nothing", () => {
    // Postgres reads sel/**/ect as two words, so this is not a SELECT.
    expect(classifyStatement("sel/**/ect 1").ok).toBe(false);
    // And a word glued to a comment is still that word.
    expect(classifyStatement("select/**/1").ok).toBe(true);
    expect(classifyStatement("select 1/**/;/**/delete from t").ok).toBe(false);
  });

  it("reads a plain string the way Postgres does with standard_conforming_strings on (a backslash is just a character)", () => {
    expect(classifyStatement("select '\\' as s").ok).toBe(true);
    expect(classifyStatement("select '\\'; delete from t; --'").ok).toBe(false);
    // Only an E string treats a backslash as an escape.
    expect(classifyStatement("select E'\\'; delete from t; --'").ok).toBe(true);
    expect(classifyStatement("select e'\\\\'; delete from t").ok).toBe(false);
  });

  it("does not take a word that merely ends in e for an escape-string prefix", () => {
    expect(classifyStatement("select name'\\'; delete from t; --'").ok).toBe(false);
  });

  it("refuses a lone ; and a statement that is only a comment", () => {
    expect(classifyStatement(";")).toMatchObject({ ok: false, reason: "empty" });
    expect(classifyStatement("/* nothing */")).toMatchObject({ ok: false, reason: "empty" });
  });

  it("is quick on text built to make a careless parser slow", () => {
    const started = Date.now();
    const deep = `select ${"(".repeat(5000)}1${")".repeat(5000)}`;
    expect(classifyStatement(deep).ok).toBe(true);
    expect(classifyStatement(`select ${"/*".repeat(5000)}`).ok).toBe(false);
    expect(classifyStatement(`select '${"''".repeat(5000)}'`).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
