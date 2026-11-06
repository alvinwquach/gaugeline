import {
  ConfigError,
  buildResult,
  DEPRECATED,
  checkSite,
  deprecate,
  createFetcher,
  EMAIL_PRESET,
  LAUNCH_PRESET,
  buildRunSnapshot,
  createDnsReader,
  createPageRegistry,
  exitCodeFor,
  resolveAccess,
  type CheckRegistry,
  type DnsReader,
  type FetcherOptions,
  type Outcome,
} from "@gaugeline/core";
import { parseCliArgs } from "./args.js";
import { HELP } from "./help.js";
import { useColor } from "./color.js";
import { formatError, toOutcome } from "./fail.js";
import { envIsOn, type FlagDef } from "./flags.js";
import { createLogger } from "./logger.js";
import { formatTerminal } from "./reporter.js";
import {
  readAccess,
  readFacts,
  readHidden,
  readLanguageRules,
  readPayments,
  readSchemaRules,
} from "./schema-config.js";
import { skeletonOnly } from "./skeleton.js";
import { readLastRun, statePath, writeLastRun } from "./state.js";
import { VERSION } from "./version.js";

/** Shown under the mail record checks a run without --dns leaves out. */
export const DNS_HINT =
  "Mail records are read from DNS only with --dns. Rerun with --dns to check them.";

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
  /** Public DNS for the email record checks. Defaults to node:dns/promises; tests pass a fake. */
  dns?: DnsReader;
  /** Defaults to the package version; tests pass one to see 0.0.x and 0.1.0 behaviour. */
  version?: string;
  /** Defaults to the flag table; tests pass one with a deprecated flag. */
  flags?: readonly FlagDef[];
  /** Defaults to core's DEPRECATED; tests pass deprecated environment variables. */
  deprecated?: ReadonlyMap<string, { since: string; removeIn: string; use?: string }>;
  /** The run's clock, for date checks. Tests pass a fixed one. */
  now?: () => Date;
  /** Where gaugeline.schema.json is looked for. Defaults to the current directory. */
  cwd?: string;
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
      io.stdout.write(`${HELP[args.command === "check" ? "" : args.command] ?? ""}\n`);
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
      // --since last: read the stored run before checking, replace it after. Without it, nothing
      // is read or written.
      const cwd = deps.cwd ?? process.cwd();
      const host = new URL(args.address).host;
      const last = args.since ? readLastRun(cwd, host) : undefined;
      if (last?.kind === "none") io.stderr.write("nothing to compare yet\n");
      if (last?.kind === "corrupt")
        io.stderr.write(
          `${statePath(".", host)} is not valid JSON: treated as no previous run, and replaced.\n`,
        );
      if (last?.kind === "newer")
        io.stderr.write(
          `${statePath(".", host)} was written by ${last.writtenBy ?? "another version"} (schema ${String(last.schema)}); this version reads schema 1, so nothing was compared.\n`,
        );
      const schemaRules = readSchemaRules(deps.cwd ?? process.cwd());
      const languageRules = readLanguageRules(deps.cwd ?? process.cwd());
      const facts = readFacts(deps.cwd ?? process.cwd());
      const payments = readPayments(deps.cwd ?? process.cwd());
      const hidden = readHidden(deps.cwd ?? process.cwd());
      const accessConfig = readAccess(deps.cwd ?? process.cwd());
      // Keys are read from the environment here and go only into request headers.
      const access = accessConfig ? resolveAccess(accessConfig, io.env ?? {}) : undefined;
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
      // launch: a preset of check ids through the runner's own `only` filter, not a second runner.
      const launch = args.command === "launch";
      const registry = deps.registry ?? createPageRegistry();
      let only: readonly string[] | undefined =
        deps.registry === undefined && skeleton ? skeleton : undefined;
      if (launch) {
        const registered = new Set(registry.all().map((c) => c.id));
        const wanted = [...LAUNCH_PRESET, ...(args.dns ? EMAIL_PRESET : [])];
        for (const id of wanted.filter((id) => !registered.has(id)))
          io.stderr.write(`${id}: not available in this version\n`);
        only = wanted.filter((id) => registered.has(id));
      }
      // DNS is read only with --dns, for either command: the default run is HTTP only. Without it,
      // the page check lists the mail record checks as not run, with the flag to run them.
      const dns = args.dns ? (deps.dns ?? createDnsReader()) : undefined;
      const registeredIds = new Set(registry.all().map((c) => c.id));
      const dnsSkipped =
        !launch && !args.dns ? EMAIL_PRESET.filter((id) => registeredIds.has(id)) : [];
      const { snapshot, result, budget } = await checkSite({
        address: args.input,
        fetcher,
        registry,
        // The walking skeleton (0.0.x) runs one check; an injected registry is used as given.
        ...(only ? { only } : {}),
        ...(dnsSkipped.length > 0 ? { skip: dnsSkipped } : {}),
        onProgress: (e) => log.progress(e),
        ...(deps.now ? { now: deps.now } : {}),
        ...(schemaRules ? { schemaRules } : {}),
        ...(languageRules ? { languageRules } : {}),
        ...(facts ? { facts } : {}),
        ...(payments ? { payments } : {}),
        ...(hidden ? { hidden } : {}),
        ...(last?.kind === "ok" ? { previous: last.snapshot } : {}),
        ...(access ? { access } : {}),
        ...(dns ? { dns } : {}),
      });
      if (args.json) {
        const json = buildResult({
          url: snapshot.requestedUrl,
          startedAt,
          findings: result.findings,
          passed: result.passed,
          failed: [...result.failed.map((f) => f.id), ...dnsSkipped],
        });
        io.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
      } else {
        io.stdout.write(
          formatTerminal({
            result,
            sampled: budget.summary(),
            color: useColor(io.stdout, env),
            ...(dnsSkipped.length > 0 ? { notRun: { ids: dnsSkipped, hint: DNS_HINT } } : {}),
          }),
        );
      }
      if (args.since && last?.kind !== "newer")
        writeLastRun(
          cwd,
          host,
          buildRunSnapshot(snapshot, () => startedAt),
          `Gaugeline ${deps.version ?? VERSION}`,
        );
      const highFindings = result.findings.filter((f) => f.severity === "high").length;
      if (launch && !args.json)
        io.stdout.write(
          highFindings === 0 ? "Ready to launch\n" : `Not yet: ${highFindings} to fix first\n`,
        );
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
