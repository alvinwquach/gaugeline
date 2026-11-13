import {
  ConfigError,
  RENEWALS_ENV_VARS,
  buildReceipt,
  createFetcher,
  createRenewals,
  freezeEnv,
  parseReceiptMonth,
  previousMonth,
  receiptJson,
  receiptMarkdown,
  receiptPrintable,
  type FetcherOptions,
  type Outcome,
  type RenewalRow,
} from "@gaugeline/core";
import { readRenewalsConfig } from "./schema-config.js";
import { readRuns } from "./runs.js";

export interface ReceiptIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  env?: Readonly<Record<string, string | undefined>>;
}

export interface ReceiptDeps {
  cwd?: string;
  now: Date;
  fetcher?: FetcherOptions;
  /** Tests: where IANA's bootstrap file is and the port https answers on, as for `gaugeline renewals`. */
  renewals?: { bootstrapUrl?: string; port?: number };
  /** Tests: what the renewals reader returns. Defaults to the F-01 reader (GET only, through the fetcher). */
  renewalRows?: (host: string, now: Date) => Promise<RenewalRow[]>;
}

/**
 * gaugeline receipt <site>: what Gaugeline caught in a month, from the runs `--since last` keeps.
 * It reads the local runs store and prints; it writes no file and sends nothing. Only --coming-up
 * asks anything, and only what `gaugeline renewals` asks (the registry and the certificates, GET).
 */
export async function runReceipt(
  args: {
    address: string;
    month?: string;
    json: boolean;
    printable: boolean;
    comingUp: boolean;
    clientReported: { checkId: string; path?: string }[];
    quiet: boolean;
  },
  io: ReceiptIo,
  deps: ReceiptDeps,
): Promise<Outcome> {
  const cwd = deps.cwd ?? process.cwd();
  const url = new URL(args.address);
  const month = args.month ?? previousMonth(deps.now);
  const span = parseReceiptMonth(month);
  if (!span) throw new ConfigError(`--month needs a month as yyyy-mm, not "${month}".`);
  if (Date.parse(span.from) > deps.now.getTime())
    throw new ConfigError(`${month} has not started yet, so there is nothing to report.`, {
      hint: "Use a month that has started, such as the one before this.",
    });

  const { runs } = readRuns(cwd, url.host);
  if (runs.length === 0 && !args.quiet)
    io.stderr.write(
      "No runs are stored for this site yet. Run it with --since last first, then ask for the receipt.\n",
    );

  let rows: RenewalRow[] = [];
  if (args.comingUp) {
    try {
      rows = await (deps.renewalRows ?? readRows(io, cwd, deps))(url.hostname, deps.now);
    } catch (err) {
      io.stderr.write(
        `Coming up was left out: the renewals could not be read (${err instanceof Error ? err.message : "it failed"}).\n`,
      );
    }
  }

  const receipt = buildReceipt({
    site: url.host,
    month,
    runs: runs.map((r) => ({
      takenAt: r.takenAt,
      pages: Object.keys(r.pages),
      findings: r.findings,
    })),
    clientReported: args.clientReported,
    renewals: rows,
    now: deps.now,
  });
  io.stdout.write(
    args.json
      ? receiptJson(receipt)
      : args.printable
        ? receiptPrintable(receipt)
        : receiptMarkdown(receipt),
  );
  return { kind: "ran", highFindings: 0, drift: false };
}

/** The F-01 reader over the real fetcher: the domain, its certificates, and the tokens and projects the config names. */
function readRows(io: ReceiptIo, cwd: string, deps: ReceiptDeps) {
  return async (host: string, now: Date): Promise<RenewalRow[]> => {
    const renewals = createRenewals(
      {
        config: readRenewalsConfig(cwd) ?? {},
        env: freezeEnv(io.env ?? {}, RENEWALS_ENV_VARS),
        ...(deps.renewals?.port !== undefined ? { port: deps.renewals.port } : {}),
        ...(deps.renewals?.bootstrapUrl ? { bootstrapUrl: deps.renewals.bootstrapUrl } : {}),
      },
      createFetcher({ ...deps.fetcher }),
    );
    await renewals.registration(host);
    await renewals.certificates(host);
    await renewals.tokens();
    await renewals.runtimes();
    return renewals.rows(now);
  };
}
