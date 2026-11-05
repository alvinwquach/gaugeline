import {
  ConfigError,
  buildResult,
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
import { useColor } from "./color.js";
import { formatError, toOutcome } from "./fail.js";
import { formatTerminal } from "./reporter.js";
import { VERSION } from "./version.js";

export interface Io {
  stdout: { write(chunk: string): unknown; isTTY?: boolean };
  stderr: { write(chunk: string): unknown; isTTY?: boolean };
  /** Defaults to an empty environment, so tests are not affected by the shell running them. */
  env?: Record<string, string | undefined>;
  /** Clock for startedAt; tests pass a fixed date. */
  now?: () => Date;
}

export function withoutQuery(address: string): string {
  const u = new URL(address);
  return `${u.origin}${u.pathname}`;
}

/** CI=true, CI=1 or any other non-empty value except "false" and "0" means a CI run. */
export function isCiEnv(env: Record<string, string | undefined>): boolean {
  const v = env.CI;
  return v !== undefined && v !== "" && v.toLowerCase() !== "false" && v !== "0";
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
      const env = io.env ?? {};
      const ci = args.ci || isCiEnv(env);
      const startedAt = (io.now ?? (() => new Date()))();
      const fetcher = createFetcher(deps.fetcher);
      // The query string can carry a token, so the header shows the address without it.
      io.stderr.write(`Gaugeline ${VERSION} checking ${withoutQuery(args.address)}\n`);
      const hops = await fetcher.getSite(args.input);
      const snapshot = buildSnapshot(hops);
      const budget = createBudget();
      const result = await runChecks(snapshot, deps.registry ?? createPageRegistry(), {
        ctx: { fetcher, budget },
      });
      for (const w of result.warnings) io.stderr.write(`warning: ${w}\n`);
      if (args.json) {
        const json = buildResult({
          url: snapshot.requestedUrl,
          startedAt,
          findings: result.findings,
          passed: result.passed,
          failed: result.failed.map((f) => f.id),
        });
        io.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
      } else {
        io.stdout.write(
          formatTerminal({ result, sampled: budget.summary(), color: useColor(io.stdout, env) }),
        );
      }
      const highFindings = result.findings.filter((f) => f.severity === "high").length;
      return { outcome: { kind: "ran", highFindings, drift: false }, ci };
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
