import {
  ConfigError,
  buildSnapshot,
  createBudget,
  createFetcher,
  createPageRegistry,
  exitCodeFor,
  runChecks,
  type CheckRegistry,
  type FetcherOptions,
  type Outcome,
} from "@gaugeline/core";
import { parseCliArgs, USAGE } from "./args.js";
import { formatError, toOutcome } from "./fail.js";
import { VERSION } from "./version.js";

export interface Io {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

/** Exit codes are a public contract: 0 ran, 1 --ci found fix-first work, 2 could not run. */
export const EXIT = { ok: 0, findings: 1, couldNotRun: 2 } as const;

export interface Deps {
  /** The checks to run. Defaults to every page check. */
  registry?: CheckRegistry;
  fetcher?: FetcherOptions;
}

export interface RunReport {
  outcome: Outcome;
  ci: boolean;
}

async function execute(argv: readonly string[], io: Io, deps: Deps): Promise<RunReport> {
  const args = parseCliArgs(argv);
  const ran: Outcome = { kind: "ran", highFindings: 0, drift: false };
  switch (args.kind) {
    case "help":
      io.stdout.write(`${USAGE}\n`);
      return { outcome: ran, ci: false };
    case "version":
      io.stdout.write(`${VERSION}\n`);
      return { outcome: ran, ci: false };
    case "error":
      throw new ConfigError(args.message, args.hint === undefined ? {} : { hint: args.hint });
    case "run": {
      const fetcher = createFetcher(deps.fetcher);
      const hops = await fetcher.getSite(args.input);
      const snapshot = buildSnapshot(hops);
      const result = await runChecks(snapshot, deps.registry ?? createPageRegistry(), {
        ctx: { fetcher, budget: createBudget() },
      });
      io.stdout.write(`Gaugeline ${VERSION} checking ${hops[0]?.url ?? args.address}\n`);
      for (const f of result.findings) io.stdout.write(`${f.severity}  ${f.checkId}  ${f.title}\n`);
      if (result.failed.length > 0) {
        io.stdout.write(`Could not run: ${result.failed.map((f) => f.id).join(", ")}\n`);
      }
      const highFindings = result.findings.filter((f) => f.severity === "high").length;
      return { outcome: { kind: "ran", highFindings, drift: false }, ci: false };
    }
  }
}

/** Runs the CLI and returns the exit code. Nothing else in the CLI decides an exit code. */
export async function main(argv: readonly string[], io: Io, deps: Deps = {}): Promise<number> {
  const verbose = argv.includes("--verbose");
  try {
    const report = await execute(argv, io, deps);
    return exitCodeFor(report.outcome, { ci: report.ci });
  } catch (err) {
    io.stderr.write(`${formatError(err, { verbose })}\n`);
    return exitCodeFor(toOutcome(err), { ci: false });
  }
}
