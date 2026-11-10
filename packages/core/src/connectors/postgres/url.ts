import { isIP } from "node:net";
import { classifyAddress } from "../../net/address-policy.js";
import { createRedactor } from "../redact.js";
import type { Env } from "../types.js";

export type SslMode = false | "prefer" | "require" | "verify-full";

export interface Connection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: SslMode;
}

export type ParsedConnection = { ok: true; value: Connection } | { ok: false; message: string };

/** The only parameters an address may carry. options= is refused: it can change session settings. */
const ACCEPTED_PARAMS = new Set(["sslmode", "pgbouncer", "connect_timeout", "application_name"]);

const BAD =
  "The connection string is not a postgres:// address with one host, a user and a database. Copy it from your database provider's connection settings.";

function hostIsLoopback(host: string): boolean {
  if (host === "localhost") return true;
  return isIP(host) !== 0 && classifyAddress(host) === "loopback";
}

/**
 * Read a connection string. It is read here, never handed to the driver whole, so the driver
 * cannot pick up options Gaugeline did not choose, and the PG* environment variables libpq reads
 * (PGHOST, PGPASSWORD, ...) are never consulted. Messages never contain any part of the value.
 * `_env` is accepted so a caller cannot be tempted to pass process.env: it is not read.
 */
export function parseConnectionString(raw: string, _env: Env): ParsedConnection {
  void _env;
  const text = raw.trim();
  if (!/^postgres(ql)?:\/\//i.test(text)) return { ok: false, message: BAD };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: BAD };
  }
  const bracketed = url.hostname.startsWith("[") && url.hostname.endsWith("]");
  const host = decodeURIComponent(
    bracketed ? url.hostname.slice(1, -1) : url.hostname,
  ).toLowerCase();
  if (host === "" || /[,/%\\\s]/.test(url.hostname))
    return {
      ok: false,
      message:
        "The connection string must name exactly one host (no list of hosts, no socket path).",
    };
  if (isIP(host) !== 0) {
    const kind = classifyAddress(host);
    if (kind === "link-local" || kind === "unspecified")
      return {
        ok: false,
        message:
          "That host is a link-local or unspecified address (where cloud metadata services live), which Gaugeline never connects to.",
      };
  }
  const port = url.port === "" ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, message: BAD };

  let sslmode: string | undefined;
  for (const [name, value] of url.searchParams) {
    if (!ACCEPTED_PARAMS.has(name))
      return {
        ok: false,
        message: `The connection string carries "${name}", which Gaugeline does not pass on (it could change how the session behaves). Remove it. Allowed: sslmode, pgbouncer.`,
      };
    if (name === "sslmode") sslmode = value;
  }
  let ssl: SslMode;
  switch (sslmode) {
    case undefined:
      ssl = hostIsLoopback(host) ? false : "require";
      break;
    case "disable":
      ssl = false;
      break;
    case "allow":
    case "prefer":
      ssl = "prefer";
      break;
    case "require":
      ssl = "require";
      break;
    case "verify-full":
    case "verify-ca":
      ssl = "verify-full";
      break;
    default:
      return {
        ok: false,
        message: "sslmode must be one of disable, prefer, require or verify-full.",
      };
  }
  let user: string;
  let password: string;
  let database: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    return { ok: false, message: BAD };
  }
  if (user === "") return { ok: false, message: "The connection string has no user name." };
  return {
    ok: true,
    value: { host, port, user, password, database: database === "" ? user : database, ssl },
  };
}

/** A password shorter than this is not blanked on its own: it would shred ordinary words. */
const MIN_PASSWORD_REDACTION = 4;

/**
 * The function every error from the driver passes through: it blanks the whole address, the
 * password as written and as decoded, and the key. (The G23 runner redacts again on the way out.)
 */
export function redactorFor(
  rawUrl: string,
  connection: Connection,
  key: string | undefined,
): (text: string) => string {
  const written = /^[a-z]+:\/\/[^:/@]*:([^@]*)@/i.exec(rawUrl.trim())?.[1] ?? "";
  const secrets: Record<string, string> = { url: rawUrl.trim() };
  if (connection.password.length >= MIN_PASSWORD_REDACTION) secrets.password = connection.password;
  if (written.length >= MIN_PASSWORD_REDACTION) secrets.written = written;
  if (key !== undefined && key.trim() !== "") secrets.key = key.trim();
  return createRedactor(secrets, Object.keys(secrets));
}
