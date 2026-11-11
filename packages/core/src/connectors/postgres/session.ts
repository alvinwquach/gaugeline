import postgres from "postgres";
import { ReadOnlyNotEnforced } from "./failure.js";
import type { Connection } from "./url.js";

/** One value of a result row, as plain data. */
export type Cell = string | number | boolean | null;
export type ResultRow = Record<string, Cell>;

export interface Limits {
  statementTimeoutMs: number;
  /** Rows kept. One more is read to know whether there were more. */
  maxRows: number;
}

export interface RawResult {
  columns: string[];
  rows: ResultRow[];
  truncated: boolean;
}

/** Carries the rows out of the transaction callback, which must end in a rollback, not a commit. */
class Done extends Error {
  constructor(readonly result: RawResult) {
    super("done");
  }
}

/** Added to the statement timeout before the client gives up on a server that stopped answering. */
const DEADLINE_SLACK_MS = 10_000;

/** How long a new connection may take to open, in seconds. */
const CONNECT_TIMEOUT_SECONDS = 10;

export interface SessionOptions {
  /** The driver's own limit for opening a connection, in seconds. */
  connectTimeoutSeconds?: number;
  /** Time the server gets, on top of the statement timeout, to say the statement was stopped. For the tests. */
  deadlineSlackMs?: number;
}

function cell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return `[binary, ${value.length} bytes]`;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error("deadline"), { code: "GAUGELINE_DEADLINE" })),
      ms,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * One connection to the database that only ever runs inside a read-only transaction.
 *
 * Each query: BEGIN READ ONLY (the first statement on the connection), a statement timeout, a check that the server really says the
 * transaction is read-only (a pooler can swallow the mode), the query through the extended protocol
 * (the server accepts one statement only) as a cursor that stops at the row cap, and ROLLBACK.
 * Nothing is ever committed. This is the second read-only layer; the classifier is the first.
 */
export class ReadOnlySession {
  private sql: postgres.Sql | undefined;

  private readonly connectTimeoutSeconds: number;
  private readonly deadlineSlackMs: number;

  constructor(
    private readonly connection: Connection,
    options: SessionOptions = {},
  ) {
    this.connectTimeoutSeconds = options.connectTimeoutSeconds ?? CONNECT_TIMEOUT_SECONDS;
    this.deadlineSlackMs = options.deadlineSlackMs ?? DEADLINE_SLACK_MS;
  }

  private open(): postgres.Sql {
    if (this.sql) return this.sql;
    const c = this.connection;
    // Every option is given, so none is taken from PG* variables in the environment.
    this.sql = postgres({
      host: c.host,
      port: c.port,
      username: c.user,
      password: c.password,
      database: c.database,
      ssl: c.ssl,
      max: 1,
      idle_timeout: 5,
      connect_timeout: this.connectTimeoutSeconds,
      max_lifetime: null,
      keep_alive: null,
      prepare: false,
      fetch_types: false,
      debug: false,
      connection: { application_name: "gaugeline" },
      onnotice: () => undefined,
    });
    return this.sql;
  }

  /**
   * Run `text` inside BEGIN READ ONLY and ROLLBACK. It does NOT classify the text: the connector
   * calls this only through its guarded path. It is exported for the tests, which call it with a
   * write on purpose to show that the database itself refuses one (SQLSTATE 25006).
   */
  async runUnchecked(text: string, limits: Limits): Promise<RawResult> {
    const sql = this.open();
    const timeout = Math.floor(limits.statementTimeoutMs);
    if (!Number.isInteger(timeout) || timeout < 1) throw new RangeError("statement timeout");
    // sql.begin sends the mode we give it as the very first statement and rolls back when its
    // callback throws. The callback always throws once it has the rows, so nothing is ever committed.
    const work = async (): Promise<RawResult> => {
      try {
        await sql.begin("read only", async (tx) => {
          await tx.unsafe(`set local statement_timeout = ${timeout}`);
          await tx.unsafe("set local idle_in_transaction_session_timeout = 30000");
          await tx.unsafe("set local standard_conforming_strings = on");
          const shown = await tx.unsafe("show transaction_read_only");
          if ((shown[0] as Record<string, unknown> | undefined)?.transaction_read_only !== "on")
            throw new ReadOnlyNotEnforced();
          let batch: Array<Record<string, unknown>> = [];
          let names: string[] = [];
          for await (const rows of tx
            .unsafe(text, [], { prepare: false })
            .cursor(limits.maxRows + 1)) {
            batch = rows as Array<Record<string, unknown>>;
            const described = (rows as unknown as { columns?: Array<{ name: string }> }).columns;
            names = described ? described.map((col) => col.name) : [];
            break;
          }
          if (names.length === 0 && batch[0]) names = Object.keys(batch[0]);
          const truncated = batch.length > limits.maxRows;
          const kept = truncated ? batch.slice(0, limits.maxRows) : batch;
          throw new Done({
            columns: names,
            rows: kept.map((row) => {
              const out: ResultRow = {};
              for (const name of names) out[name] = cell(row[name]);
              return out;
            }),
            truncated,
          });
        });
      } catch (err) {
        if (err instanceof Done) return err.result;
        throw err;
      }
      throw new Error("unreachable: the transaction callback always throws");
    };
    try {
      // The work starts with opening the connection (the first query on a session pays for it), so the
      // deadline includes the whole connect allowance. Counting only the statement timeout plus the
      // slack let a slow connection use up the slack, and the client then gave up before the server's
      // own "statement timeout" error could arrive (FIX-1).
      const budget = this.connectTimeoutSeconds * 1000 + timeout + this.deadlineSlackMs;
      return await deadline(work(), budget);
    } catch (err) {
      if ((err as { code?: unknown }).code === "GAUGELINE_DEADLINE") await this.close(true);
      throw err;
    }
  }

  async close(now = false): Promise<void> {
    const sql = this.sql;
    this.sql = undefined;
    if (sql) await sql.end({ timeout: now ? 0 : 2 }).catch(() => undefined);
  }
}
