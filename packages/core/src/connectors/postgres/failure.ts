/**
 * What went wrong talking to the database, as a kind and one plain sentence. The driver's own
 * message is used only for its SQLSTATE and never repeated unless it passes the redactor, so a
 * password or key in it cannot reach a finding or a log.
 */
export type FailureKind =
  | "config"
  | "unreachable"
  | "auth"
  | "ssl"
  | "timeout"
  | "permission"
  | "query"
  | "read-only"
  | "unexpected";

export interface Failure {
  kind: FailureKind;
  message: string;
}

/** Thrown for a failure that stops the whole read (the database cannot be used at all). */
export class DatabaseError extends Error {
  readonly kind: FailureKind;
  constructor(failure: Failure) {
    super(failure.message);
    this.name = "DatabaseError";
    this.kind = failure.kind;
  }
}

/** Thrown when the server does not report a read-only transaction after BEGIN READ ONLY. */
export class ReadOnlyNotEnforced extends Error {
  constructor() {
    super("The database did not confirm a read-only transaction.");
    this.name = "ReadOnlyNotEnforced";
  }
}

interface Codeable {
  code?: unknown;
  message?: unknown;
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

/** Turn anything the driver or the socket threw into a Failure. `where` is "host:port" for messages. */
export function describeFailure(
  err: unknown,
  where: string,
  redact: (text: string) => string,
  tlsAsked = false,
): Failure {
  if (err instanceof ReadOnlyNotEnforced)
    return {
      kind: "read-only",
      message:
        "The database did not confirm a read-only transaction (a connection pooler may be removing it), so nothing was read. Connect to the database directly, or to a pooler in session mode.",
    };
  const e = (err ?? {}) as Codeable;
  const code = typeof e.code === "string" ? e.code : "";
  const text = typeof e.message === "string" ? e.message : String(err);
  if (code === "57014") {
    return /statement timeout/i.test(text) || /timeout/i.test(text)
      ? {
          kind: "timeout",
          message:
            "The query took longer than the statement timeout and was stopped. Make it cheaper (add a where, an index or a limit) or raise timeoutMs.",
        }
      : { kind: "timeout", message: "The query was cancelled before it finished." };
  }
  if (code === "GAUGELINE_DEADLINE")
    return {
      kind: "timeout",
      message: "The database did not answer in time, so the query was abandoned.",
    };
  if (code === "28P01" || code === "28000" || code === "28P02") {
    if (/no encryption|SSL off|ssl.*required|pg_hba/i.test(text) && /encrypt|SSL/i.test(text))
      return {
        kind: "ssl",
        message: `The database at ${where} requires an encrypted connection. Add ?sslmode=require to the connection string.`,
      };
    return {
      kind: "auth",
      message: `The database at ${where} refused the user name or password in the connection string. Check them, and that this user is allowed to connect.`,
    };
  }
  if (
    /^ERR_SSL|EPROTO|SSL routines|wrong version number|does not support SSL/i.test(
      `${code} ${text}`,
    )
  )
    return {
      kind: "ssl",
      message: `The database at ${where} did not accept an encrypted connection. If it does not use TLS (a local database), add ?sslmode=disable to the connection string.`,
    };
  if (code === "25006")
    return {
      kind: "read-only",
      message:
        "The database refused to write inside the read-only transaction. Nothing was changed. Only SELECT is allowed.",
    };
  if (code === "42501")
    return {
      kind: "permission",
      message:
        "The database user is not allowed to read what the query asks for. Grant SELECT on the tables it needs to the read-only role.",
    };
  if (code.startsWith("42") || code.startsWith("22") || code.startsWith("21"))
    return {
      kind: "query",
      message: `The database could not run the query (${code}). ${shorten(redact(text))}`,
    };
  // A server without TLS answers the TLS request with "no" and then drops the connection when the
  // client says hello anyway: say what to change instead of "could not connect".
  if (tlsAsked && (code === "ECONNRESET" || code === "CONNECTION_CLOSED" || code === "EPIPE"))
    return {
      kind: "ssl",
      message: `The database at ${where} closed the connection while an encrypted one was being set up. If it does not use TLS (a local database), add ?sslmode=disable to the connection string.`,
    };
  if (NETWORK_CODES.has(code))
    return {
      kind: "unreachable",
      message:
        code === "ENOTFOUND" || code === "EAI_AGAIN"
          ? `The host name ${where.split(":")[0]} was not found. Check the connection string.`
          : code === "CONNECT_TIMEOUT" || code === "ETIMEDOUT"
            ? `The database at ${where} did not answer in time. Check the address, the port and any firewall or allow-list.`
            : `Could not connect to the database at ${where} (${code.toLowerCase().replace(/_/g, " ")}). Check that it is running and that the address and port are right.`,
    };
  if (code.startsWith("53") || code.startsWith("57P") || code.startsWith("08"))
    return {
      kind: "unreachable",
      message: `The database at ${where} is not accepting queries right now (${code}). ${shorten(redact(text))}`,
    };
  return {
    kind: "unexpected",
    message: `The database read failed${code ? ` (${code})` : ""}. ${shorten(redact(text))}`,
  };
}

function shorten(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 160 ? `${one.slice(0, 157)}...` : one;
}
