import { createServer, type Server, type Socket } from "node:net";

/**
 * A stand-in for a Postgres server, just enough of the wire protocol to talk to the real driver.
 * It exists so the read-only guarantee is proved on every machine, with or without a Postgres
 * server installed: every message the driver sends is recorded, so a test can assert that a refused
 * statement never reached the socket and that an allowed one arrived inside BEGIN READ ONLY.
 */

export interface FakeColumn {
  name: string;
  /** Type oid: 25 text (default), 23 int4, 16 bool. */
  oid?: number;
}
export interface FakeRows {
  columns: FakeColumn[];
  rows: Array<Array<string | null>>;
  command?: string;
}
export interface FakeError {
  error: { code: string; message: string };
}
export type FakeReply = FakeRows | FakeError | undefined;

export interface FakeOptions {
  /** Answer a query that is not one of the session statements (BEGIN, SET, SHOW, ROLLBACK). */
  onQuery?: (sql: string) => FakeReply;
  /** Reject the startup message with this error (a wrong password, no encryption). */
  startupError?: { code: string; message: string };
  /** Behave as a server with no TLS: answer the TLS request with N. Always true here. */
  /** Say what `show transaction_read_only` answers; "on" by default. */
  readOnlyAnswer?: "on" | "off";
  /** Hold back the answer to the startup message by this many ms, like a server that is slow to accept a connection. */
  startupDelayMs?: number;
  /** A statement for which the server never says anything, like a server that has stopped answering. */
  silentOn?: (sql: string) => boolean;
}

export interface Received {
  protocol: "simple" | "extended";
  sql: string;
}

export interface FakePostgres {
  port: number;
  /** Every statement the driver sent, in order, from every connection. */
  received: Received[];
  /** The startup parameters of the latest connection. */
  startup: Record<string, string>;
  /** True when a client asked for TLS. */
  sawTlsRequest: boolean;
  close(): Promise<void>;
}

const i32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const i16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const cstr = (s: string): Buffer => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
const msg = (type: string, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type, "latin1"), i32(body.length + 4), body]);
};

function errorMessage(e: { code: string; message: string }): Buffer {
  return msg(
    "E",
    Buffer.from("S"),
    cstr("ERROR"),
    Buffer.from("C"),
    cstr(e.code),
    Buffer.from("M"),
    cstr(e.message),
    Buffer.from([0]),
  );
}

function rowDescription(columns: FakeColumn[]): Buffer {
  return msg(
    "T",
    i16(columns.length),
    ...columns.map((c) =>
      Buffer.concat([cstr(c.name), i32(0), i16(0), i32(c.oid ?? 25), i16(-1), i32(-1), i16(0)]),
    ),
  );
}

function dataRow(row: Array<string | null>): Buffer {
  return msg(
    "D",
    i16(row.length),
    ...row.map((v) =>
      v === null ? i32(-1) : Buffer.concat([i32(Buffer.byteLength(v)), Buffer.from(v, "utf8")]),
    ),
  );
}

const isError = (r: FakeReply): r is FakeError => r !== undefined && "error" in r;

export async function startFakePostgres(options: FakeOptions = {}): Promise<FakePostgres> {
  const received: Received[] = [];
  const sockets = new Set<Socket>();
  const state = { startup: {} as Record<string, string>, sawTlsRequest: false };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    let started = false;
    let txn: "I" | "T" | "E" = "I";
    let failed = false; // an extended-protocol error: skip until Sync
    let portal: { rows: Array<Array<string | null>>; sent: number; command: string } | undefined;
    let described: FakeRows | FakeError | undefined;

    const ready = (): Buffer => msg("Z", Buffer.from(txn));

    const answerSession = (sql: string): FakeReply | "handled" => {
      const s = sql.trim().replace(/\s+/g, " ").toLowerCase();
      if (s.startsWith("begin")) {
        txn = "T";
        return { columns: [], rows: [], command: "BEGIN" };
      }
      if (s === "rollback" || s === "commit") {
        txn = "I";
        return { columns: [], rows: [], command: s.toUpperCase() };
      }
      if (s.startsWith("set ")) return { columns: [], rows: [], command: "SET" };
      if (s === "show transaction_read_only")
        return {
          columns: [{ name: "transaction_read_only" }],
          rows: [[options.readOnlyAnswer ?? "on"]],
          command: "SHOW",
        };
      return undefined;
    };

    const reply = (sql: string): FakeRows | FakeError => {
      const session = answerSession(sql);
      if (session !== undefined && session !== "handled") return session as FakeRows;
      const custom = options.onQuery?.(sql);
      return custom ?? { columns: [], rows: [], command: "SELECT 0" };
    };

    const handle = (type: string, body: Buffer): void => {
      if (type === "X") {
        socket.end();
        return;
      }
      if (failed && type !== "S") return;
      if (type === "Q") {
        const sql = body.toString("utf8").replace(/\0$/, "");
        received.push({ protocol: "simple", sql });
        if (options.silentOn?.(sql)) return;
        const r = reply(sql);
        if (isError(r)) {
          if (txn === "T") txn = "E";
          socket.write(Buffer.concat([errorMessage(r.error), ready()]));
          return;
        }
        socket.write(
          Buffer.concat([
            ...(r.columns.length > 0 ? [rowDescription(r.columns)] : []),
            ...r.rows.map(dataRow),
            msg("C", cstr(r.command ?? `SELECT ${r.rows.length}`)),
            ready(),
          ]),
        );
        return;
      }
      if (type === "P") {
        const nameEnd = body.indexOf(0);
        const sqlEnd = body.indexOf(0, nameEnd + 1);
        const sql = body.subarray(nameEnd + 1, sqlEnd).toString("utf8");
        received.push({ protocol: "extended", sql });
        if (options.silentOn?.(sql)) return;
        const r = reply(sql);
        described = r;
        if (isError(r)) {
          failed = true;
          if (txn === "T") txn = "E";
          socket.write(errorMessage(r.error));
          return;
        }
        portal = { rows: r.rows, sent: 0, command: r.command ?? "SELECT" };
        socket.write(msg("1"));
        return;
      }
      if (type === "D") {
        const kind = String.fromCharCode(body[0] as number);
        if (!described || isError(described)) return;
        const cols = described.columns;
        socket.write(
          Buffer.concat([
            ...(kind === "S" ? [msg("t", i16(0))] : []),
            cols.length > 0 ? rowDescription(cols) : msg("n"),
          ]),
        );
        return;
      }
      if (type === "B") {
        socket.write(msg("2"));
        return;
      }
      if (type === "E") {
        const nameEnd = body.indexOf(0);
        const max = body.readInt32BE(nameEnd + 1);
        if (!portal) return;
        const remaining = portal.rows.length - portal.sent;
        const take = max > 0 ? Math.min(max, remaining) : remaining;
        const slice = portal.rows.slice(portal.sent, portal.sent + take);
        portal.sent += take;
        const done = portal.sent >= portal.rows.length;
        socket.write(
          Buffer.concat([
            ...slice.map(dataRow),
            done ? msg("C", cstr(`SELECT ${portal.rows.length}`)) : msg("s"),
          ]),
        );
        return;
      }
      if (type === "C") {
        socket.write(msg("3"));
        return;
      }
      if (type === "S") {
        failed = false;
        socket.write(ready());
        return;
      }
      // H (flush) and anything else: nothing to say.
    };

    const pump = (): void => {
      for (;;) {
        if (!started) {
          if (buffer.length < 8) return;
          if (buffer[0] === 0x16) {
            // A TLS hello sent to a server that said no: not a startup message.
            socket.write(errorMessage({ code: "08P01", message: "unsupported frontend protocol" }));
            socket.end();
            return;
          }
          const len = buffer.readInt32BE(0);
          if (buffer.length < len) return;
          const code = buffer.readInt32BE(4);
          const body = buffer.subarray(8, len);
          buffer = buffer.subarray(len);
          if (code === 80877103) {
            state.sawTlsRequest = true;
            socket.write("N");
            continue;
          }
          if (code !== 196608) {
            // Anything else (a TLS hello sent to a server that said no) is not a startup message.
            socket.write(errorMessage({ code: "08P01", message: "unsupported frontend protocol" }));
            socket.end();
            return;
          }
          const parts = body.toString("utf8").split("\0");
          const params: Record<string, string> = {};
          for (let i = 0; i + 1 < parts.length; i += 2)
            if (parts[i]) params[parts[i] as string] = parts[i + 1] as string;
          state.startup = params;
          started = true;
          if (options.startupError) {
            socket.write(errorMessage(options.startupError));
            socket.end();
            return;
          }
          const accepted = Buffer.concat([
            msg("R", i32(0)),
            msg("S", cstr("server_version"), cstr("16.0")),
            msg("S", cstr("standard_conforming_strings"), cstr("on")),
            msg("S", cstr("client_encoding"), cstr("UTF8")),
            msg("K", i32(1), i32(2)),
            ready(),
          ]);
          if (options.startupDelayMs)
            setTimeout(() => socket.destroyed || socket.write(accepted), options.startupDelayMs);
          else socket.write(accepted);
          continue;
        }
        if (buffer.length < 5) return;
        const len = buffer.readInt32BE(1);
        if (buffer.length < len + 1) return;
        const type = String.fromCharCode(buffer[0] as number);
        const body = buffer.subarray(5, len + 1);
        buffer = buffer.subarray(len + 1);
        handle(type, body);
      }
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    received,
    get startup() {
      return state.startup;
    },
    get sawTlsRequest() {
      return state.sawTlsRequest;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
