import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttp } from "./http.js";
import { normaliseHostPort } from "./net-guard.js";
import { SERVER_VERSION, createGaugelineServer } from "./server.js";
import { createState } from "./state.js";

export const HELP = `gaugeline-mcp: Gaugeline as an MCP server. Read-only: it never writes, publishes or changes a site.

Usage:
  gaugeline-mcp                      serve over stdio (the default for assistants that start a server)
  gaugeline-mcp --http               serve streamable HTTP on 127.0.0.1:7433/mcp

Options:
  --http                  serve over HTTP instead of stdio
  --port <n>              HTTP port (default 7433)
  --host <address>        HTTP bind address (default 127.0.0.1)
  --allow-non-loopback    allow a bind address other than loopback; needs GAUGELINE_MCP_TOKEN and --allowed-host
  --allowed-host <name>   a Host header value clients may use (repeat); needed with a non-loopback bind
  --allowed-origin <o>    an Origin a browser client may send (repeat); by default none
  --allow-private         let a tool check loopback and private addresses (your own machine or network).
                          Link-local and cloud-metadata addresses (169.254.x.x, fd00:ec2::254 ...) are never requested.
  --allow-private-host <host:port>
                          a private address a tool may reach (repeat for more). With any of these, no other
                          private address is reachable, and --allow-private is not needed.
  --root <folder>         the folder plan_check reads plan files from. plan_check is off without --root and --plan-base.
  --plan-base <origin>    an origin plan_check may check a plan against (repeat for more)
  --allow-probing         let probing checks run (they ask for non-public paths such as /.env or a download route, with
                          no login). Alone it enables nothing: it needs --probing-origin. Run only on sites you own
                          or have permission to test.
  --probing-origin <origin>
                          an origin probing checks may run on (repeat for more); needs --allow-probing. With probing
                          on for a call, every request of that call stays on that origin.
  --help, --version

The token for HTTP comes from the environment (GAUGELINE_MCP_TOKEN), never from the command line. Over HTTP a token is
required whenever --allow-private, --allow-private-host, --root, --plan-base or --allow-probing is given: every holder of
the token shares the session's runs.
Probing checks run only when you start the server with --allow-probing and --probing-origin for the site. A tool call has
no argument that turns them on, so a page that tells an assistant to ask for them gets nothing.
`;

interface Parsed {
  http: boolean;
  port: number;
  host: string;
  allowNonLoopback: boolean;
  allowedHosts: string[];
  allowedOrigins: string[];
  allowPrivate: boolean;
  allowPrivateHosts: string[];
  planBases: string[];
  allowProbing: boolean;
  probingOrigins: string[];
  root: string | undefined;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[], cwd: string): Parsed {
  const out: Parsed = {
    http: false,
    port: 7433,
    host: "127.0.0.1",
    allowNonLoopback: false,
    allowedHosts: [],
    allowedOrigins: [],
    allowPrivate: false,
    allowPrivateHosts: [],
    planBases: [],
    allowProbing: false,
    probingOrigins: [],
    root: undefined,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value.`);
      return v;
    };
    if (a === "--http") out.http = true;
    else if (a === "--port") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0 || n > 65535)
        throw new Error("--port needs a number from 0 to 65535.");
      out.port = n;
    } else if (a === "--host") out.host = value();
    else if (a === "--allow-non-loopback") out.allowNonLoopback = true;
    else if (a === "--allowed-host") out.allowedHosts.push(value());
    else if (a === "--allowed-origin") out.allowedOrigins.push(value());
    else if (a === "--allow-private") out.allowPrivate = true;
    else if (a === "--allow-private-host") out.allowPrivateHosts.push(normaliseHostPort(value()));
    else if (a === "--plan-base") {
      const v = value();
      if (!URL.canParse(v) || !/^https?:$/.test(new URL(v).protocol))
        throw new Error(
          "--plan-base needs an http or https origin, for example https://preview.harbourline.example.",
        );
      out.planBases.push(new URL(v).origin);
    } else if (a === "--allow-probing") out.allowProbing = true;
    else if (a === "--probing-origin") {
      const v = value();
      if (!URL.canParse(v) || !/^https?:$/.test(new URL(v).protocol))
        throw new Error(
          "--probing-origin needs an http or https origin, for example https://harbourline.example.",
        );
      out.probingOrigins.push(new URL(v).origin);
    } else if (a === "--root") out.root = resolve(cwd, value());
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else throw new Error(`Unknown option ${a}. See --help.`);
  }
  // One without the other enables nothing, so say so instead of starting a server that looks configured.
  if (out.allowProbing !== out.probingOrigins.length > 0 && !out.help && !out.version)
    throw new Error(
      "--allow-probing and --probing-origin go together: probing checks run only on an origin you name.",
    );
  return out;
}

export interface Io {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: Record<string, string | undefined>;
  cwd: string;
}

/**
 * One tool call must never take the server down: a rejection nobody handled is logged as a fixed line (no
 * detail, which could carry page text) and the server keeps serving. Installed once, only where a server starts.
 */
let safetyNet = false;
type Proc = Pick<NodeJS.Process, "on" | "exit">;
export function installSafetyNet(io: Pick<Io, "stderr">, proc: Proc = process): void {
  if (safetyNet && proc === process) return;
  if (proc === process) safetyNet = true;
  // A promise nobody handled belongs to a tool call (every call below awaits its work): log one fixed
  // line and keep serving.
  proc.on("unhandledRejection", () => {
    io.stderr.write(
      "gaugeline-mcp: a tool call failed unexpectedly; the server is still running.\n",
    );
  });
  // An exception thrown outside any promise (a timer, a socket) cannot be tied to one call and may leave
  // the process in a state nobody checked: say so in one fixed line and stop with a non-zero code.
  proc.on("uncaughtException", () => {
    io.stderr.write("gaugeline-mcp: stopping after an unexpected error outside a tool call.\n");
    proc.exit(1);
  });
}

/** Returns an exit code once the server stops. stdout is the protocol in stdio mode: logs go to stderr only. */
export async function main(argv: string[], io: Io): Promise<number> {
  let args: Parsed;
  try {
    args = parseArgs(argv, io.cwd);
  } catch (e) {
    io.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  if (args.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    io.stdout.write(`${SERVER_VERSION}\n`);
    return 0;
  }
  const options = {
    allowPrivate: args.allowPrivate,
    allowPrivateHosts: args.allowPrivateHosts,
    planBases: args.planBases,
    allowProbing: args.allowProbing,
    probingOrigins: args.probingOrigins,
    ...(args.root !== undefined ? { root: args.root } : {}),
    state: createState(),
  };
  // Over HTTP, anything that widens what a tool can reach needs a token: without one, any process on the
  // machine could call the tools, and runs are shared by every caller.
  const widened =
    args.allowPrivate ||
    args.allowPrivateHosts.length > 0 ||
    args.root !== undefined ||
    args.planBases.length > 0 ||
    args.allowProbing;
  if (args.http && widened && !io.env.GAUGELINE_MCP_TOKEN) {
    io.stderr.write(
      "Over HTTP, --allow-private, --allow-private-host, --root, --plan-base and --allow-probing need a token: set GAUGELINE_MCP_TOKEN.\n",
    );
    return 2;
  }
  installSafetyNet(io);
  if (!args.http) {
    const server = createGaugelineServer(options);
    await server.connect(new StdioServerTransport());
    io.stderr.write(`gaugeline-mcp ${SERVER_VERSION} serving over stdio (read-only)\n`);
    await new Promise<void>((done) => {
      server.server.onclose = done;
      process.stdin.once("end", done);
    });
    return 0;
  }
  try {
    const running = await startHttp({
      makeServer: () => createGaugelineServer(options),
      host: args.host,
      port: args.port,
      allowNonLoopback: args.allowNonLoopback,
      allowedHosts: args.allowedHosts,
      allowedOrigins: args.allowedOrigins,
      ...(io.env.GAUGELINE_MCP_TOKEN ? { token: io.env.GAUGELINE_MCP_TOKEN } : {}),
    });
    io.stderr.write(`gaugeline-mcp ${SERVER_VERSION} serving ${running.url} (read-only)\n`);
    await new Promise<void>((done) => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
    await running.close();
    return 0;
  } catch (e) {
    io.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
}
