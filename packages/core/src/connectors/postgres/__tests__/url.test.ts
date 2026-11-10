import { describe, expect, it } from "vitest";
import { parseConnectionString, redactorFor } from "../url.js";

const HOST = "db.example.test";
const pw = ["p@ss", "w/rd:1"].join(""); // characters that need percent-encoding in a URL
const encoded = encodeURIComponent(pw);

describe("parseConnectionString", () => {
  it("reads host, port, user, password and database from a postgres:// address, decoding percent-encoding", () => {
    const c = parseConnectionString(`postgres://reader:${encoded}@${HOST}:6543/bar`, {});
    expect(c).toMatchObject({
      ok: true,
      value: { host: "db.example.test", port: 6543, user: "reader", password: pw, database: "bar" },
    });
  });

  it("accepts postgresql:// and defaults the port and the database", () => {
    const c = parseConnectionString(`postgresql://reader:x@${HOST}`, {});
    expect(c).toMatchObject({ ok: true, value: { port: 5432, database: "reader" } });
  });

  it("requires TLS away from this machine and leaves it optional on a loopback address", () => {
    const far = parseConnectionString(`postgres://r:x@${HOST}/d`, {});
    const near = parseConnectionString("postgres://r:x@127.0.0.1:5432/d", {});
    expect(far).toMatchObject({ ok: true, value: { ssl: "require" } });
    expect(near).toMatchObject({ ok: true, value: { ssl: false } });
  });

  it("honours sslmode", () => {
    for (const [mode, ssl] of [
      ["disable", false],
      ["require", "require"],
      ["verify-full", "verify-full"],
      ["prefer", "prefer"],
    ] as const) {
      const c = parseConnectionString(`postgres://r:x@${HOST}/d?sslmode=${mode}`, {});
      expect(c, mode).toMatchObject({ ok: true, value: { ssl } });
    }
  });

  it("refuses any other query parameter, since options= could switch read-only off", () => {
    const c = parseConnectionString(
      `postgres://r:x@${HOST}/d?options=-c%20default_transaction_read_only%3Doff`,
      {},
    );
    expect(c.ok).toBe(false);
    expect(JSON.stringify(c)).toMatch(/options/);
    expect(JSON.stringify(c)).not.toContain("default_transaction_read_only");
  });

  it("ignores pgbouncer=true (Supabase's pooler addresses carry it)", () => {
    expect(parseConnectionString(`postgres://r:x@${HOST}:6543/d?pgbouncer=true`, {}).ok).toBe(true);
  });

  it("refuses a value that is not a postgres address without echoing it", () => {
    for (const bad of [
      "",
      "mysql://u:p@h/d",
      "hunter2-not-a-url",
      "postgres://",
      "http://u:p@h/d",
    ]) {
      const c = parseConnectionString(bad, {});
      expect(c.ok, bad).toBe(false);
      if (bad !== "") expect(JSON.stringify(c)).not.toContain(bad);
    }
  });

  it("refuses an address with no host in it, a unix socket path and more than one host", () => {
    expect(parseConnectionString("postgres://r:x@/d", {}).ok).toBe(false);
    expect(parseConnectionString(`postgres://r:x@a.${HOST},b.${HOST}/d`, {}).ok).toBe(false);
    expect(parseConnectionString("postgres://r:x@%2Fvar%2Frun%2Fpostgresql/d", {}).ok).toBe(false);
  });

  it("refuses a link-local or unspecified host (cloud metadata lives there) always", () => {
    for (const host of ["169.254.169.254", "0.0.0.0", "[fe80::1]", "[::]"]) {
      const c = parseConnectionString(`postgres://r:x@${host}/d`, {});
      expect(c.ok, host).toBe(false);
    }
  });

  it("does not read PGHOST, PGPASSWORD or the other libpq variables", () => {
    const c = parseConnectionString(`postgres://r@${HOST}/d`, {
      PGPASSWORD: "from-env",
      PGHOST: "elsewhere.test",
    });
    expect(c).toMatchObject({ ok: true, value: { password: "", host: "db.example.test" } });
  });
});

describe("redactorFor", () => {
  it("blanks the whole address, the password as written, the decoded password and the key", () => {
    const url = `postgres://reader:${encoded}@${HOST}:5432/bar`;
    const key = ["eyJhbGciOi", "payload", "sig"].join(".");
    const parsed = parseConnectionString(url, {});
    if (!parsed.ok) throw new Error("setup");
    const redact = redactorFor(url, parsed.value, key);
    const text = `could not connect to ${url} with ${pw} and ${encoded} and key ${key}`;
    const out = redact(text);
    for (const secret of [url, pw, encoded, key]) expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("does not blank a password of one or two characters everywhere (it would shred the message)", () => {
    const parsed = parseConnectionString(`postgres://reader:x@${HOST}/bar`, {});
    if (!parsed.ok) throw new Error("setup");
    const redact = redactorFor(`postgres://reader:x@${HOST}/bar`, parsed.value, undefined);
    expect(redact("max 5 connections to example")).toBe("max 5 connections to example");
  });
});
