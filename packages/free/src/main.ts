import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  CheckRegistry,
  ConfigError,
  NetworkError,
  buildSnapshot,
  classifyHop,
  comparePrices,
  createBudget,
  createFetcher,
  describeRefusal,
  pricesDisagree,
  readPrices,
  renderReport,
  runChecks,
  type DnsReader,
  type Fetcher,
  type FetcherOptions,
  type PriceReading,
  type RunResult,
} from "@gaugeline/core";
import { main as gaugeline, REPORT_FILE } from "../../cli/src/main.js";
import { formatTerminal } from "../../cli/src/reporter.js";
import { version } from "../package.json";

export const VERSION: string = version;

/** The commands, with their status exactly as the landing page's Free tools section gives it. */
export const COMMANDS = [
  {
    name: "price",
    usage: "price <product-url>",
    title: "Price agreement check",
    status: "New",
  },
  { name: "launch", usage: "launch <site>", title: "Launch-day check", status: "New" },
  {
    name: "study",
    usage: "study <stores.txt>",
    title: "How often does a store disagree with itself?",
    status: undefined,
  },
] as const;

export const HELP = [
  "Usage: gaugeline-free <command> [options]",
  "",
  "Free tools from Gaugeline: no keys, no account. Read-only.",
  "",
  "Commands:",
  ...COMMANDS.map((c) => `  ${c.usage.padEnd(22)}${c.title}${c.status ? ` (${c.status})` : ""}`),
  "",
  "Options:",
  '  --ci                  Exit 1 when a "Fix this first" finding is found [CI]',
  "  --json                Print the result as JSON (study: the rows)",
  "  --allow-private       Allow addresses on this computer or a private network",
  "  -h, --help            Show this help and exit",
  "  -v, --version         Print the version and exit",
  "",
  "Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run",
].join("\n");

export interface Io {
  stdout: { write(chunk: string): unknown; isTTY?: boolean };
  stderr: { write(chunk: string): unknown; isTTY?: boolean };
  env?: Record<string, string | undefined>;
}

export interface Deps {
  fetcher?: FetcherOptions;
  /** For launch's mail record lookups; tests pass a fake. */
  dns?: DnsReader;
  cwd?: string;
  now?: () => Date;
}

const ON = /^(1|true|yes|on)$/i;

/** One store in a study: a product page, and what was read. */
export interface StudyRow {
  url: string;
  reading?: PriceReading;
  disagreements: string[];
  /** Why it couldn't be read (a refusal, an error): counted as could not check, never as agreeing. */
  couldNotCheck?: string;
}

/** stores.txt: one product address per line; blank lines and # comments skipped; duplicates once. */
export function parseStores(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    let key: string;
    try {
      const u = new URL(line);
      u.hash = "";
      key = u.href;
    } catch {
      throw new ConfigError(`stores.txt: "${line}" is not an address.`, {
        hint: "Put one product address per line, for example https://shop.example/products/mug.",
      });
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function registry(): CheckRegistry {
  return new CheckRegistry().register(pricesDisagree);
}

/** Read one product page: its prices, or why it could not be read. */
export async function readStore(url: string, fetcher: Fetcher): Promise<StudyRow> {
  let hops;
  try {
    hops = await fetcher.get(url);
  } catch (err) {
    if (err instanceof NetworkError) return { url, disagreements: [], couldNotCheck: err.message };
    throw err;
  }
  const outcome = classifyHop(hops.at(-1));
  if (outcome.kind === "refused")
    return { url, disagreements: [], couldNotCheck: describeRefusal(outcome) };
  const page = buildSnapshot(hops);
  const reading = await readPrices(page, fetcher);
  return { url, reading, disagreements: comparePrices(reading).map((d) => d.message) };
}

const money = (n: number | undefined) => (n === undefined ? "-" : (n / 100).toFixed(2));

/** The study table: one row per store, then the totals. */
export function studyTable(rows: readonly StudyRow[]): string {
  const lines = [
    `${"Store".padEnd(48)} ${"Page".padStart(9)} ${"Data".padStart(9)} ${"Charged".padStart(9)}  Result`,
  ];
  for (const r of rows) {
    const result = r.couldNotCheck
      ? `could not check: ${r.couldNotCheck}`
      : r.disagreements.length > 0
        ? `disagree: ${r.disagreements.join("; ")}`
        : "agree";
    const name = r.url.length > 48 ? `${r.url.slice(0, 47)}…` : r.url;
    lines.push(
      `${name.padEnd(48)} ${money(r.reading?.visible).padStart(9)} ${money(r.reading?.structured).padStart(9)} ${money(r.reading?.charged).padStart(9)}  ${result}`,
    );
  }
  const read = rows.filter((r) => !r.couldNotCheck);
  const disagree = read.filter((r) => r.disagreements.length > 0).length;
  const failed = rows.length - read.length;
  lines.push(
    "",
    `Stores read: ${read.length}. Stores where the prices disagree: ${disagree}.${failed > 0 ? ` Could not check: ${failed}.` : ""}`,
  );
  return `${lines.join("\n")}\n`;
}

function writeReport(cwd: string, result: RunResult, url: string, startedAt: Date, io: Io): void {
  try {
    writeFileSync(
      join(cwd, REPORT_FILE),
      renderReport({ result, url, startedAt, registry: registry(), version: VERSION }),
    );
    io.stderr.write(`Report written to ./${REPORT_FILE}\n`);
  } catch (err) {
    const code = (err as { code?: string }).code ?? "an error";
    io.stderr.write(`Could not write ./${REPORT_FILE} in this folder (${code}).\n`);
  }
}

function exitFor(result: RunResult, ci: boolean): number {
  return ci && result.findings.some((f) => f.severity === "high") ? 1 : 0;
}

export async function main(argv: readonly string[], io: Io, deps: Deps = {}): Promise<number> {
  const env = io.env ?? {};
  const cwd = deps.cwd ?? process.cwd();
  const [command, ...rest] = argv;
  if (command === "launch") {
    // The launch-day check is gaugeline launch with the mail record lookups: the same summary.
    return gaugeline(["launch", ...rest, "--dns"], io, {
      cwd,
      ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
      ...(deps.dns ? { dns: deps.dns } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...(command === "price" || command === "study" ? rest : argv)],
      allowPositionals: true,
      strict: true,
      options: {
        ci: { type: "boolean" },
        json: { type: "boolean" },
        "allow-private": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    io.stderr.write(`${(err as Error).message.split("\n")[0] ?? "Unknown option."}\n${HELP}\n`);
    return 2;
  }
  const v = parsed.values;
  if (v.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (v.help || (command !== "price" && command !== "study")) {
    io.stdout.write(`${HELP}\n`);
    return v.help || command === undefined ? 0 : 2;
  }
  const target = parsed.positionals[0];
  if (!target || parsed.positionals.length > 1) {
    io.stderr.write(
      `gaugeline-free ${command} needs one ${command === "price" ? "product address" : "file of store addresses"}.\n`,
    );
    return 2;
  }
  const ci = v.ci === true || ON.test(env.CI ?? "");
  const fetcher = createFetcher({
    ...deps.fetcher,
    ...(v["allow-private"] ? { allowPrivate: true } : {}),
  });
  const startedAt = (deps.now ?? (() => new Date()))();
  try {
    if (command === "price") {
      const hops = await fetcher.get(new URL(target).href);
      const page = buildSnapshot(hops);
      const outcome = classifyHop(hops.at(-1));
      const result: RunResult =
        outcome.kind === "refused"
          ? {
              findings: [],
              passed: [],
              failed: [],
              warnings: [],
              couldNotCheck: [
                {
                  id: "prices-disagree",
                  reason: `the page ${describeRefusal(outcome)}`,
                  url: page.finalUrl,
                },
              ],
              sampled: {},
            }
          : await runChecks(page, registry(), { ctx: { fetcher } });
      if (v.json)
        io.stdout.write(`${JSON.stringify({ url: page.finalUrl, ...result }, null, 2)}\n`);
      else
        io.stdout.write(
          formatTerminal({
            result,
            sampled: createBudget().summary(),
            color: false,
            origin: new URL(page.finalUrl).origin,
          }),
        );
      if (!v.json) writeReport(cwd, result, page.finalUrl, startedAt, io);
      return exitFor(result, ci);
    }
    // study: one store at a time, each with the normal per-site limits.
    const file = resolve(cwd, target);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new ConfigError(`${target} could not be read.`, {
        hint: "Give a text file with one product address per line.",
      });
    }
    const rows: StudyRow[] = [];
    for (const url of parseStores(text)) rows.push(await readStore(url, fetcher));
    const result: RunResult = {
      findings: rows.flatMap((r) =>
        r.disagreements.length > 0
          ? [
              {
                checkId: "prices-disagree",
                severity: "high" as const,
                title: pricesDisagree.title,
                evidence: r.disagreements.join("; "),
                url: r.url,
              },
            ]
          : [],
      ),
      passed: [],
      failed: [],
      warnings: [],
      couldNotCheck: rows.flatMap((r) =>
        r.couldNotCheck ? [{ id: "prices-disagree", reason: r.couldNotCheck, url: r.url }] : [],
      ),
      sampled: {},
    };
    if (v.json) io.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    else {
      io.stdout.write(studyTable(rows));
      writeReport(cwd, result, target, startedAt, io);
    }
    return exitFor(result, ci);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof NetworkError || err instanceof TypeError) {
      io.stderr.write(`${(err as Error).message}\n`);
      return 2;
    }
    throw err;
  }
}
