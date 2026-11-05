import {
  ConfigError,
  buildResult,
  DEPRECATED,
  checkSite,
  deprecate,
  createFetcher,
  exitCodeFor,
  type CheckRegistry,
  type FetcherOptions,
  type Outcome,
} from "@gaugeline/core";
import { parseCliArgs, USAGE } from "./args.js";
import { useColor } from "./color.js";
import { formatError, toOutcome } from "./fail.js";
import { envIsOn, type FlagDef } from "./flags.js";
import { createLogger } from "./logger.js";
import { formatTerminal } from "./reporter.js";
import { skeletonOnly } from "./skeleton.js";
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
  return envIsOn(env.CI);
}

/** Exit codes are a public contract: 0 ran, 1 --ci found fix-first work, 2 could not run. */
export const EXIT = { ok: 0, findings: 1, couldNotRun: 2 } as const;

export interface Deps {
  /** The checks to run. Defaults to every page check. */
  registry?: CheckRegistry;
  fetcher?: FetcherOptions;
  /** Defaults to the package version; tests pass one to see 0.0.x and 0.1.0 behaviour. */
  version?: string;
  /** Defaults to the flag table; tests pass one with a deprecated flag. */
  flags?: readonly FlagDef[];
  /** Defaults to core's DEPRECATED; tests pass deprecated environment variables. */
  deprecated?: ReadonlyMap<string, { since: string; removeIn: string; use?: string }>;
  /** The run's clock, for date checks. Tests pass a fixed one. */
  now?: () => Date;
}

export interface RunReport {
  outcome: Outcome;
  ci: boolean;
}

async function execute(argv: readonly string[], io: Io, deps: Deps): Promise<RunReport> {
  const args = parseCliArgs(argv, io.env ?? {}, deps.flags);
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
      const ci = args.ci;
      // Deprecations: one line on stderr per key per run, never stdout, and the exit code is unchanged.
      const warn = (line: string) => io.stderr.write(`${line}\n`);
      for (const f of args.deprecatedUsed)
        if (f.deprecated) deprecate(`--${f.name}`, f.deprecated, warn);
      for (const [key, d] of deps.deprecated ?? DEPRECATED) {
        const name = key.startsWith("env:") ? key.slice(4) : undefined;
        if (name && (env[name] ?? "") !== "") deprecate(key, d, warn);
      }
      const startedAt = (io.now ?? (() => new Date()))();
      const log = createLogger({
        level: args.quiet ? "quiet" : args.verbose ? "verbose" : "normal",
        stream: io.stderr,
        color: useColor(io.stderr, env),
      });
      const fetcher = createFetcher({
        ...deps.fetcher,
        ...(args.allowPrivate ? { allowPrivate: true } : {}),
        onRequest: (info) => log.request(info),
      });
      if (!args.quiet) {
        // The query string can carry a token, so the header shows the address without it.
        io.stderr.write(`Gaugeline ${VERSION} checking ${withoutQuery(args.address)}\n`);
      }
      const skeleton = skeletonOnly(deps.version ?? VERSION);
      const { snapshot, result, budget } = await checkSite({
        address: args.input,
        fetcher,
        ...(deps.registry ? { registry: deps.registry } : {}),
        // The walking skeleton (0.0.x) runs one check; an injected registry is used as given.
        ...(deps.registry === undefined && skeleton ? { only: skeleton } : {}),
        onProgress: (e) => log.progress(e),
        ...(deps.now ? { now: deps.now } : {}),
      });
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
  // formatError reads the same level as the logger; --quiet --verbose is refused before this matters.
  const verbose = argv.includes("--verbose") && !argv.includes("--quiet");
  try {
    const report = await execute(argv, io, deps);
    return exitCodeFor(report.outcome, { ci: report.ci });
  } catch (err) {
    io.stderr.write(`${formatError(err, { verbose })}\n`);
    return exitCodeFor(toOutcome(err), { ci: false });
  }
}
