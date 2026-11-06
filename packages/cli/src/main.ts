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
  notifyAll,
  resolveTargets,
  shouldNotify,
  parseResult,
  type Result,
  renderReport,
  exitCodeFor,
  formatTagSummary,
  EMAIL_FROM_ENV,
  ONBOARDING_FROM,
  RESEND_KEY_ENV,
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
import { runDigest } from "./digest.js";
import { formatTerminal } from "./reporter.js";
import {
  readAccess,
  readFacts,
  readHidden,
  readLanguageRules,
  readPayments,
  readEvents,
  readSchemaRules,
  readTags,
} from "./schema-config.js";
import { skeletonOnly } from "./skeleton.js";
import { readLastRun, statePath, writeLastRun } from "./state.js";
import { openInBrowser } from "./open.js";
import { addIgnore, applyIgnore, IGNORE_FILE, readIgnore } from "./ignore.js";
import { canShowView, runView, type ViewIo } from "./tui/app.js";
import { existsSync, readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** The report file, in the folder the run starts from. */
export const REPORT_FILE = "gaugeline-report.html";
import { VERSION } from "./version.js";

/** Shown under the mail record checks a run without --dns leaves out. */
export const DNS_HINT =
  "Mail records are read from DNS only with --dns. Rerun with --dns to check them.";

export interface Io {
  /** For the interactive view only. */
  stdin?: ViewIo["stdin"];
  stdout: { write(chunk: string): unknown; isTTY?: boolean; columns?: number; rows?: number };
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
  /** Opens the written report. Defaults to the system browser; tests pass a fake. */
  open?: (path: string) => void;
  /** Where the email is POSTed. Defaults to Resend's API; tests pass a local server. */
  emailEndpoint?: string;
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
    case "digest": {
      await runDigest(
        {
          runs: args.runs,
          ...(args.timeZone ? { timeZone: args.timeZone } : {}),
          notify: args.notify,
          quiet: args.quiet,
          cwd: deps.cwd ?? process.cwd(),
          ...(deps.emailEndpoint ? { emailEndpoint: deps.emailEndpoint } : {}),
        },
        { stdout: io.stdout, stderr: io.stderr, env: io.env ?? {} },
      );
      return { outcome: ran, ci: false };
    }
    case "view": {
      const cwd = deps.cwd ?? process.cwd();
      const path = join(cwd, args.file);
      if (!existsSync(path))
        throw new ConfigError(`${args.file} does not exist.`, {
          hint: "Save a run with gaugeline <address> --json > run.json.",
        });
      let saved: Result;
      try {
        saved = parseResult(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        throw new ConfigError(`${args.file} is not a saved Gaugeline run (--json output).`, {
          hint: "Save a run with gaugeline <address> --json > run.json.",
        });
      }
      await runView({
        result: saved,
        registry: deps.registry ?? createPageRegistry(),
        stdin: io.stdin ?? process.stdin,
        stdout: io.stdout,
        onDismiss: (d) => addIgnore(cwd, d, (io.now ?? (() => new Date()))()),
      });
      return { outcome: ran, ci: false };
    }
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
      const tags = readTags(deps.cwd ?? process.cwd());
      const events = readEvents(deps.cwd ?? process.cwd());
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
      const {
        snapshot,
        result,
        budget,
        tags: tagSummary,
      } = await checkSite({
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
        ...(tags ? { tags } : {}),
        // No observer until rendered reads (G39): the click event checks are could not check.
        ...(events ? { events } : {}),
        ...(last?.kind === "ok" ? { previous: last.snapshot } : {}),
        ...(access ? { access } : {}),
        ...(dns ? { dns } : {}),
      });
      // Findings dismissed with a reason (gaugeline.ignore.json, written by the view's d key).
      const ignored = readIgnore(cwd);
      if (ignored.length > 0) {
        const { kept, dismissed } = applyIgnore(result.findings, ignored);
        result.findings = kept;
        if (dismissed > 0 && !args.quiet)
          io.stderr.write(
            `${dismissed} finding${dismissed === 1 ? "" : "s"} dismissed in ${IGNORE_FILE}\n`,
          );
      }
      if (args.json) {
        const json = buildResult({
          url: snapshot.requestedUrl,
          startedAt,
          findings: result.findings,
          passed: result.passed,
          failed: [...result.failed.map((f) => f.id), ...dnsSkipped],
          couldNotCheck: result.couldNotCheck,
          sampled: result.sampled,
        });
        io.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
      } else {
        io.stdout.write(
          formatTerminal({
            result,
            sampled: budget.summary(),
            color: useColor(io.stdout, env),
            origin: new URL(snapshot.finalUrl).origin,
            ...(dnsSkipped.length > 0 ? { notRun: { ids: dnsSkipped, hint: DNS_HINT } } : {}),
          }),
        );
      }
      // How many of the container's triggers can fire: one stderr line, like the sample line.
      if (tagSummary && !args.json && !args.quiet)
        io.stderr.write(`${formatTagSummary(tagSummary)}\n`);
      if (args.since && last?.kind !== "newer")
        writeLastRun(
          cwd,
          host,
          buildRunSnapshot(snapshot, () => startedAt),
          `Gaugeline ${deps.version ?? VERSION}`,
        );
      // The report: one self-contained file, written on every run that isn't --json, opened only
      // for a person at a terminal (not with --no-open, not in CI, not when piped).
      if (!args.json) {
        const reportPath = join(cwd, REPORT_FILE);
        // A folder the run can't write to (a read-only checkout, /) costs the report, not the run.
        let written = false;
        try {
          writeFileSync(
            reportPath,
            renderReport({
              result,
              url: snapshot.finalUrl,
              startedAt,
              registry,
              sampled: budget.summary(),
              version: deps.version ?? VERSION,
            }),
          );
          written = true;
        } catch (err) {
          const code = (err as { code?: string }).code ?? "an error";
          io.stderr.write(
            `Could not write ./${REPORT_FILE} in this folder (${code}); the results above are complete. Run from a folder you can write to, or use --json.\n`,
          );
        }
        if (written && !args.quiet) io.stderr.write(`Report written to ./${REPORT_FILE}\n`);
        if (written && !args.noOpen && !isCiEnv(env) && io.stdout.isTTY === true)
          (deps.open ?? openInBrowser)(reportPath);
      }
      // Notifications: the person's own channels. A failed send is reported and never changes the
      // exit code; a webhook's address is never printed, only its host.
      const targets = resolveTargets(args.notify, env);
      if (targets.length > 0) {
        const sent = buildResult({
          url: snapshot.requestedUrl,
          startedAt,
          findings: result.findings,
          passed: result.passed,
          failed: [...result.failed.map((f) => f.id), ...dnsSkipped],
          couldNotCheck: result.couldNotCheck,
          sampled: result.sampled,
        });
        const NAME = { slack: "Slack", discord: "Discord", webhook: "the webhook" } as const;
        const emailing = targets.some((t) => t.channel === "email");
        const from = env[EMAIL_FROM_ENV]?.trim();
        if (!shouldNotify(sent, args.notifyOn)) {
          io.stderr.write(
            `Nothing sent: --notify-on ${args.notifyOn} and ${args.notifyOn === "high" ? "nothing needs fixing first" : "nothing was found"}.\n`,
          );
        } else {
          if (emailing && !from && env[RESEND_KEY_ENV])
            io.stderr.write(
              `Email is sent from Resend's shared address (${ONBOARDING_FROM}). Set ${EMAIL_FROM_ENV} to send from your own domain.\n`,
            );
          for (const r of await notifyAll(sent, targets, {
            ...(args.reportUrl ? { reportUrl: args.reportUrl } : {}),
            // The key is read here and goes only into the Authorization header of one request.
            email: {
              ...(env[RESEND_KEY_ENV] ? { apiKey: env[RESEND_KEY_ENV] } : {}),
              ...(from ? { from } : {}),
              ...(deps.emailEndpoint ? { endpoint: deps.emailEndpoint } : {}),
              version: deps.version ?? VERSION,
            },
          }))
            io.stderr.write(
              r.channel === "email"
                ? r.ok
                  ? "Emailed the report.\n"
                  : `Could not send the email: ${r.error ?? "it failed"}.\n`
                : r.ok
                  ? `Sent to ${NAME[r.channel]}.\n`
                  : `Could not send to ${NAME[r.channel]}: ${r.error ?? "it failed"}.\n`,
            );
        }
      }
      // -i: the terminal view over this run, for a person at a wide enough terminal, never in CI.
      const stdin = io.stdin ?? process.stdin;
      if (
        args.interactive &&
        !args.json &&
        !isCiEnv(env) &&
        canShowView({ stdin, stdout: io.stdout })
      )
        await runView({
          result: buildResult({
            url: snapshot.requestedUrl,
            startedAt,
            findings: result.findings,
            passed: result.passed,
            failed: result.failed.map((f) => f.id),
            couldNotCheck: result.couldNotCheck,
            sampled: result.sampled,
          }),
          registry,
          stdin,
          stdout: io.stdout,
          onDismiss: (d) => addIgnore(cwd, d, startedAt),
        });
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
