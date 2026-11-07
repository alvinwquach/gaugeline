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
  readPlan,
  applyLegacy,
  annotate,
  BUILT_CHECK_IDS,
  checkBuilt,
  type BuiltResult,
  REDIRECT_CHECK_IDS,
  checkRedirects,
  type RedirectResult,
  createBudget,
  createPlanRegistry,
  extractLegacy,
  legacyHints,
  legacyReviewCsv,
  runChecks,
  type LegacyMention,
  EMAIL_FROM_ENV,
  ONBOARDING_FROM,
  RESEND_KEY_ENV,
  resolveAccess,
  type CheckRegistry,
  type DnsReader,
  type FetcherOptions,
  type Outcome,
  authHeaders,
  previewAuth,
  type PreviewAuth,
  comparePlanProgress,
  fingerprint,
  progressLine,
  type PlanState,
  planHash,
  watchDay,
  watchLine,
  watchSummary,
  checkPrinted,
  createPrintedRegistry,
  readQr,
  readRegister,
  registerAdditions,
  checkCoverage,
  readLive,
  type CoverageOptions,
  type CoverageResult,
  type LiveRead,
  coverageKey,
  rankUncovered,
  rankUnknown,
  readRankExport,
  type Finding,
  NAV_CHECK_IDS,
  checkNav,
  navLabelRows,
  navTabLine,
  readNav,
  type NavResult,
} from "@gaugeline/core";
import { parseCliArgs } from "./args.js";
import { HELP } from "./help.js";
import { useColor } from "./color.js";
import { formatError, toOutcome } from "./fail.js";
import { envIsOn, type FlagDef } from "./flags.js";
import { createLogger } from "./logger.js";
import { runDigest } from "./digest.js";
import { formatLegacyTable, formatPlanSummary } from "./plan.js";
import { formatTerminal } from "./reporter.js";
import { runCutover } from "./cutover.js";
import { runSnapshot } from "./snapshot.js";
import { runVerify } from "./verify.js";
import { formatRunAll, runAll, runAllExit } from "./run-all.js";
import { readSites, selectSites, SITES_FILE } from "./sites.js";
import { appendStepSummary, planStepSummary } from "./step-summary.js";
import {
  readAccess,
  readFacts,
  readHidden,
  readLanguageRules,
  readPayments,
  readEvents,
  readSchemaRules,
  readTags,
  readNavRules,
  readPagesConfig,
} from "./schema-config.js";
import { skeletonOnly } from "./skeleton.js";
import { readLastRun, statePath, writeLastRun } from "./state.js";
import { defaultPlanStatePath, readPlanStateFile, writePlanStateFile } from "./plan-state.js";
import { openInBrowser } from "./open.js";
import { addIgnore, applyIgnore, IGNORE_FILE, readIgnore } from "./ignore.js";
import { canShowView, runView, type ViewIo } from "./tui/app.js";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

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
    case "plan": {
      const cwd = deps.cwd ?? process.cwd();
      const path = resolve(cwd, args.file);
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(path);
      } catch {
        throw new ConfigError(`${args.file} could not be read.`, {
          hint: "Export the plan from your spreadsheet as CSV or .xlsx and give its path.",
        });
      }
      // CSV, a multi-tab text export or .xlsx: the file's first bytes decide, not its name.
      const plan = readPlan(bytes, {
        fileName: basename(args.file),
        ...(args.sheet !== undefined ? { sheet: args.sheet } : {}),
      });
      const tabs = plan.workbook.sheets.length;
      if (tabs > 1 && !args.quiet)
        io.stderr.write(
          `Read tab: ${plan.workbook.chosen.name.trim()} (${tabs - 1} other tab${tabs === 2 ? "" : "s"} ${args.nav !== undefined ? "read for menus with --nav" : "skipped"}${args.annotate !== undefined ? "; the annotated copy has this tab only" : ""})\n`,
        );
      // --watch: the 30-day cutover watch. The day is counted before anything else; after day 30
      // the command stops itself, with no request.
      let watching: number | undefined;
      if (args.watch !== undefined) {
        if (args.base === undefined)
          throw new ConfigError(
            "--watch re-checks production against the plan: add --base with the production address.",
          );
        const day = watchDay(args.watch, deps.now?.() ?? new Date());
        if (day.kind === "over") {
          io.stdout.write(
            `The 30-day watch is over: the cutover was ${args.watch}, ${day.day - 1} days ago. No request was made.\n`,
          );
          return { outcome: { kind: "ran", highFindings: 0, drift: false }, ci: true };
        }
        watching = day.day;
      }
      // --progress: the last run's state, read before any request so a file this version can't
      // read stops the run (exit 2) before it costs anything.
      if (args.progress !== undefined && args.base === undefined)
        throw new ConfigError(
          "--progress compares runs of the plan against a preview: add --base.",
        );
      // --watch implies --progress: the state file beside the plan, unless one is named.
      const progressPath =
        args.progress === undefined
          ? args.watch !== undefined
            ? defaultPlanStatePath(path)
            : undefined
          : args.progress === ""
            ? defaultPlanStatePath(path)
            : resolve(cwd, args.progress);
      let previous: PlanState | undefined;
      if (progressPath) {
        const last = readPlanStateFile(progressPath);
        if (last.kind === "ok") previous = last.state;
        if (last.kind === "corrupt" && !args.quiet)
          io.stderr.write(
            `${progressPath} could not be read: treated as the first run. The old file is kept as ${last.backup}.\n`,
          );
      }
      if (watching !== undefined) {
        io.stdout.write(
          `${watchLine(watching, previous !== undefined && previous.planHash !== planHash(plan.rows))}\n`,
        );
        if (!previous)
          io.stdout.write(
            "No saved state for this watch: this run is the baseline. On a scheduled run that usually means the CI cache was cleared, which is fine.\n",
          );
      }
      io.stdout.write(formatPlanSummary(plan, args.file));
      // --nav: the menu tabs, read first so the per-tab count shows how each was read. Pure.
      let nav: NavResult | undefined;
      if (args.nav !== undefined) {
        const tabs = readNav(plan.workbook, { names: args.nav, rows: plan.rows });
        for (const tab of tabs) io.stdout.write(`${navTabLine(tab)}\n`);
        nav = checkNav(
          tabs.flatMap((t) => t.items),
          plan.rows,
          {
            labels: navLabelRows(plan.workbook.chosen, plan.columns.page, plan.columns.url),
            file: basename(args.file),
          },
        );
        if (!args.quiet)
          for (const w of [...tabs.flatMap((t) => t.warnings), ...nav.notes])
            io.stderr.write(`${w}\n`);
      }
      // Old addresses in a notes column (--legacy-from): read, shown for review, then checked.
      const headers = Object.keys(plan.rows[0]?.raw ?? {});
      let mentions: LegacyMention[] = [];
      if (args.legacyReview && args.legacyFrom.length === 0)
        throw new ConfigError(
          "--legacy-review needs --legacy-from: it writes the old addresses read from a notes column.",
          {
            hint: 'Add --legacy-from "<notes column>".',
          },
        );
      if (args.legacyFrom.length > 0) {
        if (plan.columns.legacyUrl !== undefined)
          throw new ConfigError(
            `The plan has a Legacy URL column ("${plan.columns.legacyUrl}") and --legacy-from ${args.legacyFrom.map((c) => `"${c}"`).join(", ")}: drop --legacy-from to use the column, or remove the column to read the notes.`,
          );
        const columns = args.legacyFrom.map((name) => {
          const found = headers.find((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
          if (!found)
            throw new ConfigError(
              `--legacy-from: there is no column named "${name}". Headers: ${headers.join(", ")}.`,
            );
          return found;
        });
        mentions = extractLegacy(plan.rows, columns);
        applyLegacy(plan.rows, mentions);
        io.stdout.write(formatLegacyTable(mentions, columns));
        if (args.legacyReview) {
          writeFileSync(resolve(cwd, args.legacyReview), legacyReviewCsv(mentions));
          if (!args.quiet) io.stderr.write(`Review table written to ${args.legacyReview}\n`);
        }
      } else if (plan.columns.legacyUrl === undefined && !args.quiet) {
        const own = Object.values(plan.columns);
        for (const h of legacyHints(plan.rows, own))
          io.stderr.write(
            `"${h.column}" mentions "legacy" in ${h.rows} row${h.rows === 1 ? "" : "s"}: add --legacy-from "${h.column}" to read old addresses from it.\n`,
          );
      }
      if (plan.columns.primaryKeyword === undefined && !args.quiet)
        io.stderr.write("Keyword checks skipped: the plan has no Primary Keyword column.\n");
      // --printed: the register's addresses join the 301 map, each on the row of its expected page.
      if (args.printed !== undefined) {
        if (args.base === undefined)
          throw new ConfigError("--printed checks printed addresses on a preview: add --base.");
        const printedRows = readRegister(readText(resolve(cwd, args.printed), args.printed));
        let unplaced = 0;
        for (const p of printedRows) {
          let printedPath: string;
          let expectedPath: string | undefined;
          try {
            const u = new URL(p.url);
            printedPath = `${u.pathname}${u.search}`;
            expectedPath = p.expectedDestination
              ? new URL(p.expectedDestination, u).pathname
              : undefined;
          } catch {
            continue;
          }
          const same = (a: string, b: string) =>
            a.toLowerCase().replace(/\/+$/, "") === b.toLowerCase().replace(/\/+$/, "");
          if (plan.rows.some((r) => same(r.path, printedPath.split("?")[0] ?? ""))) continue;
          const target = expectedPath
            ? plan.rows.find((r) => same(r.path, expectedPath))
            : undefined;
          if (!target) {
            unplaced++;
            continue;
          }
          target.legacyUrl = target.legacyUrl ? `${target.legacyUrl}\n${printedPath}` : printedPath;
        }
        if (unplaced > 0 && !args.quiet)
          io.stderr.write(
            `${unplaced} printed address${unplaced === 1 ? " has" : "es have"} no planned page to land on: give ${unplaced === 1 ? "it" : "them"} an expectedDestination in ${args.printed}.\n`,
          );
      }
      // The built site against the plan (--base): each planned path fetched once with GET.
      let built: BuiltResult | undefined;
      let redirects: RedirectResult | undefined;
      if (args.base !== undefined) {
        if (args.planOnly)
          throw new ConfigError("Choose --plan-only or --base: --plan-only makes no request.");
        const base = args.base;
        let origin: string;
        try {
          origin = new URL(base).origin;
        } catch {
          throw new ConfigError(`--base: "${base}" is not an address.`, {
            hint: "Give the preview's address, for example https://preview.yoursite.com.",
          });
        }
        // A protected preview: the secret from the environment, sent to this origin only.
        const auth = previewAuth(io.env ?? {}, origin);
        if (auth?.warning && !args.quiet) io.stderr.write(`${auth.warning}\n`);
        const fetcher = createFetcher({
          ...deps.fetcher,
          ...(args.allowPrivate ? { allowPrivate: true } : {}),
          ...(auth ? { headersFor: authHeaders(auth) } : {}),
        });
        try {
          built = await checkBuilt(plan.rows, {
            base,
            fetcher,
            file: basename(args.file),
            ...(auth ? { auth } : {}),
            onProgress: (done, total) => {
              if (done === 1 && !args.quiet)
                io.stderr.write(
                  `Reading ${total} planned address${total === 1 ? "" : "es"} on ${origin}${auth ? ` (${auth.describe})` : ""}\n`,
                );
            },
          });
        } catch (err) {
          // A locked preview is exit 2 even when the plan has findings of its own: say so, so a CI
          // job held at 2 isn't read as "the plan is clean".
          if (
            err instanceof ConfigError &&
            err.message.startsWith("Could not check: the preview")
          ) {
            const own = (
              await runChecks(
                { plan, legacy: mentions, file: basename(args.file) },
                createPlanRegistry(),
                {
                  skip: [
                    ...BUILT_CHECK_IDS,
                    ...REDIRECT_CHECK_IDS,
                    "plan-uncovered-page",
                    "plan-rank-unknown-address",
                    ...NAV_CHECK_IDS,
                  ],
                },
              )
            ).findings.length;
            if (own > 0)
              throw new ConfigError(
                `${err.message} The plan has ${own} finding${own === 1 ? "" : "s"} of its own, not evaluated against the site and not reported: this run could not finish.`,
                { ...(err.hint ? { hint: err.hint } : {}) },
              );
          }
          throw err;
        }
        // The 301 map: each old address in the Legacy URL column, on the same preview.
        redirects = await checkRedirects(plan.rows, {
          base,
          fetcher,
          file: basename(args.file),
          onProgress: (done, total) => {
            if (done === 1 && !args.quiet)
              io.stderr.write(
                `Reading ${total} old address${total === 1 ? "" : "es"} from the Legacy URL column\n`,
              );
          },
        });
        if (!args.quiet) for (const note of redirects.notes) io.stderr.write(`${note}\n`);
      }
      if (args.rank !== undefined && args.live === undefined)
        throw new ConfigError(
          "--rank adds traffic numbers to the pages --live finds missing from the plan: add --live.",
        );
      // --live: what exists today, read as a stream, against every planned and legacy path.
      let coverage: CoverageResult | undefined;
      let rankUnknownFindings: Finding[] | undefined;
      let rankSummary: string | undefined;
      if (args.live !== undefined) {
        const livePath = resolve(cwd, args.live);
        if (!existsSync(livePath) || !statSync(livePath).isFile())
          throw new ConfigError(`--live: ${args.live} could not be read.`, {
            hint: "Give a crawl export, a sitemap.xml, a Search Console export or a list of addresses.",
          });
        // One pass: the format (and its clicks column) is known from the first line, and the
        // uncovered pages are sorted only once the stream has ended.
        let format: LiveRead | undefined;
        const options: CoverageOptions = {
          file: basename(args.file),
          ...(args.rank !== undefined ? { keepLive: true } : {}),
          ...(args.ignore.length > 0 ? { ignore: args.ignore } : {}),
        };
        coverage = await checkCoverage(
          plan.rows,
          readLive(createReadStream(livePath), (r) => {
            format = r;
            // --rank wins over --live's own clicks column.
            if (r.metric && args.rank === undefined) options.metric = r.metric;
          }),
          options,
        );
        // --rank: the traffic numbers, joined on the same path key, read as a stream. No request.
        if (args.rank !== undefined) {
          const rankPath = resolve(cwd, args.rank);
          if (!existsSync(rankPath) || !statSync(rankPath).isFile())
            throw new ConfigError(`--rank: ${args.rank} could not be read.`);
          const rank = await readRankExport(createReadStream(rankPath));
          const ranked = rankUncovered(coverage.findings, rank, {
            pages: coverage.pages,
            file: basename(args.rank),
          });
          coverage = { ...coverage, findings: ranked.findings };
          rankSummary = ranked.summary;
          const planned = new Set(
            plan.rows.flatMap((r) => {
              const k = coverageKey(r.path);
              return k ? [k] : [];
            }),
          );
          const live = coverage.liveKeys;
          rankUnknownFindings = rankUnknown(
            rank,
            (k) => planned.has(k) || live?.has(k) === true,
            basename(args.rank),
          );
        }
        if (!args.quiet)
          io.stderr.write(
            `Read ${coverage.live} live address${coverage.live === 1 ? "" : "es"} from ${args.live} (${describeLive(format)}); ${coverage.ignored} left out as assets, feeds, paged or --ignore\n`,
          );
      }
      // The plan against itself (no requests). Any finding is drift: exit 1, so it can gate a launch.
      const planResult = await runChecks(
        {
          plan,
          legacy: mentions,
          file: basename(args.file),
          ...(built ? { built } : {}),
          ...(redirects ? { redirects } : {}),
          ...(coverage ? { coverage } : {}),
          ...(rankUnknownFindings ? { rankUnknown: rankUnknownFindings } : {}),
          ...(nav ? { nav } : {}),
        },
        createPlanRegistry(),
        {
          skip: [
            ...(built ? [] : [...BUILT_CHECK_IDS, ...REDIRECT_CHECK_IDS]),
            ...(coverage ? [] : ["plan-uncovered-page"]),
            ...(rankUnknownFindings ? [] : ["plan-rank-unknown-address"]),
            ...(nav ? [] : NAV_CHECK_IDS),
          ],
        },
      );
      // With --progress: the new findings in full, the fixed ones one line each, the rest as a count.
      let shown = planResult;
      let footer: string[] | undefined;
      let watchNew: Finding[] | undefined;
      if (progressPath && args.base !== undefined) {
        if (planResult.couldNotCheck.length > 0) {
          if (!args.quiet)
            io.stderr.write(
              `No progress saved to ${progressPath}: some planned pages could not be checked.\n`,
            );
        } else {
          const progress = comparePlanProgress(previous, planResult.findings, plan.rows, {
            base: new URL(args.base).origin,
            at: (deps.now?.() ?? new Date()).toISOString(),
          });
          writePlanStateFile(progressPath, progress.state);
          const added = new Set(progress.added);
          watchNew = planResult.findings.filter((f) => added.has(fingerprint(f)));
          if (watching !== undefined && previous) {
            // Only what is new since the last day; the known ones as a count, the fixed ones named.
            if (!args.all)
              shown = {
                ...planResult,
                findings: planResult.findings.filter((f) => added.has(fingerprint(f))),
              };
            footer = [
              ...progress.fixed.map((k) => {
                const was = previous?.open[k];
                return `✓ Fixed: ${was?.title ?? k}${was ? ` (line ${was.line} last time)` : ""}`;
              }),
              watchSummary(progress.added.length, progress.still, progress.fixed.length),
            ];
          } else if (watching !== undefined) {
            footer = [
              `Baseline saved: ${Object.keys(progress.state.open).length} finding${Object.keys(progress.state.open).length === 1 ? "" : "s"} open. From the next run, only new ones are reported.`,
            ];
          } else if (!args.all)
            shown = {
              ...planResult,
              findings: planResult.findings.filter((f) => added.has(fingerprint(f))),
            };
          if (watching === undefined)
            footer = [
              ...progress.fixed.map((k) => {
                const was = previous?.open[k];
                return `✓ Fixed: ${was?.title ?? k}${was ? ` (line ${was.line} last time)` : ""}`;
              }),
              ...(!args.all && progress.still > 0
                ? [
                    `${progress.still} still open: add --all to list ${progress.still === 1 ? "it" : "them"}.`,
                  ]
                : []),
              progressLine(progress),
            ];
        }
      }
      if (rankSummary) io.stdout.write(`${rankSummary}\n`);
      io.stdout.write(
        formatTerminal({
          result: shown,
          sampled: createBudget().summary(),
          color: useColor(io.stdout, io.env ?? {}),
          ...(footer ? { footer } : {}),
        }),
      );
      // In GitHub Actions: a short Markdown summary on the run's page. Nothing without the variable.
      appendStepSummary(
        io.env ?? {},
        planStepSummary({
          file: basename(args.file),
          rows: plan.rows.length,
          findings: shown.findings,
          couldNotCheck: shown.couldNotCheck.length,
        }),
      );
      // Notifications: the findings shown (with --watch, only the new ones), to the person's own
      // webhooks. A failed send is reported and never changes the exit code.
      const planTargets = resolveTargets(args.notify, io.env ?? {}).filter(
        (t) => t.channel !== "email",
      );
      if (planTargets.length > 0) {
        const sent = buildResult({
          url: args.base ?? basename(args.file),
          startedAt: deps.now?.() ?? new Date(),
          findings: shown.findings,
          passed: shown.passed,
          failed: shown.failed.map((f) => f.id),
          couldNotCheck: shown.couldNotCheck,
        });
        if (!shouldNotify(sent, args.notifyOn)) {
          if (!args.quiet)
            io.stderr.write(
              `Nothing sent: --notify-on ${args.notifyOn} and ${args.notifyOn === "high" ? "nothing needs fixing first" : watching !== undefined ? "nothing is new" : "nothing was found"}.\n`,
            );
        } else {
          const NAMES = {
            slack: "Slack",
            discord: "Discord",
            webhook: "the webhook",
            email: "email",
          } as const;
          for (const r of await notifyAll(sent, planTargets))
            io.stderr.write(
              r.ok
                ? `Sent to ${NAMES[r.channel]}.\n`
                : `Could not send to ${NAMES[r.channel]}: ${r.error ?? "it failed"}.\n`,
            );
        }
      }
      // The annotated copy: a new file next to the plan, never the plan itself. The exit code doesn't change.
      if (args.annotate !== undefined) {
        const target = resolve(
          cwd,
          args.annotate !== ""
            ? args.annotate
            : `${basename(args.file).replace(/\.[^.]+$/, "")}.gaugeline.csv`,
        );
        if (target === path)
          throw new ConfigError(`--annotate would write over the plan itself (${args.file}).`, {
            hint: "Give another file name, or leave it out to use <plan>.gaugeline.csv.",
          });
        const text = annotate(plan.workbook.chosen, plan.rows, planResult.findings);
        try {
          writeFileSync(target, text, { flag: args.force ? "w" : "wx" });
        } catch (err) {
          const code = (err as { code?: string }).code;
          throw new ConfigError(
            code === "EEXIST"
              ? `${target} already exists: add --force to replace it.`
              : `Could not write ${target} (${code ?? "an error"}); the findings above are complete.`,
          );
        }
        if (!args.quiet) io.stderr.write(`Annotated copy written to ${target}\n`);
      }
      return {
        outcome: {
          kind: "ran",
          // The watch counts only what is new: known drift exits 0, new drift exits 1 (the baseline
          // day by the normal rule).
          highFindings: (watching !== undefined && previous && watchNew
            ? watchNew
            : planResult.findings
          ).filter((f) => f.severity === "high").length,
          drift:
            watching !== undefined && previous && watchNew
              ? watchNew.length > 0
              : planResult.findings.length > 0,
          // A planned page behind a password was not checked: the run could not finish (exit 2).
          incomplete: planResult.couldNotCheck.length > 0,
        },
        ci: true,
      };
    }
    case "printed": {
      const cwd = deps.cwd ?? process.cwd();
      const path = resolve(cwd, args.file);
      let text = readText(path, args.file);
      // --decode: what was actually printed, read from the images on this computer.
      const unread: { image: string; reason: string }[] = [];
      if (args.decode.length > 0) {
        const images = args.decode.flatMap((d) => {
          const full = resolve(cwd, d);
          let isDir = false;
          try {
            isDir = statSync(full).isDirectory();
          } catch {
            throw new ConfigError(`--decode: ${d} could not be read.`);
          }
          return isDir
            ? readdirSync(full)
                .filter((f) => f.toLowerCase().endsWith(".png"))
                .sort()
                .map((f) => join(full, f))
            : [full];
        });
        const decoded: { url: string; where: string }[] = [];
        for (const image of images) {
          const read = readQr(readFileSync(image));
          if (!read.ok) unread.push({ image: basename(image), reason: read.reason });
          else if (!/^https?:\/\//i.test(read.text))
            unread.push({
              image: basename(image),
              reason: `its QR code holds "${read.text}", not an address`,
            });
          else decoded.push({ url: read.text, where: basename(image) });
        }
        const add = registerAdditions(text, decoded);
        if (add !== "") {
          appendFileSync(path, text.endsWith("\n") || text === "" ? add : `\n${add}`);
          text = readText(path, args.file);
        }
        if (!args.quiet)
          io.stderr.write(
            `Read ${decoded.length} QR code${decoded.length === 1 ? "" : "s"} from ${images.length} image${images.length === 1 ? "" : "s"}; ${add === "" ? "the register already had every address" : `added ${add.trimEnd().split("\n").length} to ${args.file}`}\n`,
          );
      }
      const rows = readRegister(text);
      const places = new Set(rows.map((r) => r.where)).size;
      io.stdout.write(
        `Read ${rows.length} printed address${rows.length === 1 ? "" : "es"} from ${args.file}, in ${places} place${places === 1 ? "" : "s"}.\n`,
      );
      for (const u of unread) io.stdout.write(`? ${u.image} could not be checked: ${u.reason}\n`);
      const fetcher = createFetcher({
        ...deps.fetcher,
        ...(args.allowPrivate ? { allowPrivate: true } : {}),
      });
      const printed = await checkPrinted(rows, {
        fetcher,
        file: basename(args.file),
        ...(args.tags ? { tags: args.tags } : {}),
      });
      const result = await runChecks(
        { printed, file: basename(args.file) },
        createPrintedRegistry(),
      );
      io.stdout.write(
        formatTerminal({
          result,
          sampled: createBudget().summary(),
          color: useColor(io.stdout, io.env ?? {}),
        }),
      );
      return {
        outcome: {
          kind: "ran",
          highFindings: result.findings.filter((f) => f.severity === "high").length,
          drift: result.findings.length > 0,
          incomplete: result.couldNotCheck.length > 0,
        },
        ci: true,
      };
    }
    case "snapshot":
      return {
        outcome: await runSnapshot(args, io, {
          ...deps,
          ...(deps.now ? {} : io.now ? { now: io.now } : {}),
        }),
        ci: false,
      };
    case "run-all": {
      const cwd = deps.cwd ?? process.cwd();
      const picked = selectSites(readSites(cwd), {
        all: args.all,
        names: args.sites,
        ...(args.tag !== undefined ? { tag: args.tag } : {}),
      });
      if (picked.length === 0) {
        io.stderr.write(
          `No site in ${SITES_FILE} has the tag "${args.tag ?? ""}": nothing to check.\n`,
        );
        return { outcome: ran, ci: false };
      }
      if (!args.quiet)
        io.stderr.write(
          `Checking ${picked.length} site${picked.length === 1 ? "" : "s"}${args.parallel > 1 ? `, up to ${args.parallel} at once` : ""}\n`,
        );
      const rows = await runAll(picked, {
        runsDir: join(cwd, "runs"),
        env: io.env ?? {},
        ...(io.now ? { now: io.now } : deps.now ? { now: deps.now } : {}),
        parallel: args.parallel,
        allowPrivate: args.allowPrivate,
        runOne: (argv, siteIo, siteCwd) => main(argv, siteIo, { ...deps, cwd: siteCwd }),
      });
      io.stdout.write(`${formatRunAll(rows)}\n`);
      const code = runAllExit(rows);
      return {
        outcome:
          code === 2
            ? { kind: "ran", highFindings: 0, drift: false, incomplete: true }
            : { kind: "ran", highFindings: code === 1 ? 1 : 0, drift: false },
        ci: true,
      };
    }
    case "verify":
      return {
        outcome: (
          await runVerify(args, io, { cwd: deps.cwd ?? process.cwd(), fetcher: deps.fetcher })
        ).outcome,
        ci: args.ci,
      };
    case "cutover":
      return {
        outcome: await runCutover(
          args,
          { ...io, color: useColor(io.stdout, io.env ?? {}) },
          { ...deps, ...(deps.now ? {} : io.now ? { now: io.now } : {}) },
        ),
        ci: true,
      };
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
      const navRules = readNavRules(deps.cwd ?? process.cwd());
      const pagesConfig = readPagesConfig(deps.cwd ?? process.cwd());
      const accessConfig = readAccess(deps.cwd ?? process.cwd());
      // Keys are read from the environment here and go only into request headers.
      const access = accessConfig ? resolveAccess(accessConfig, io.env ?? {}) : undefined;
      const log = createLogger({
        level: args.quiet ? "quiet" : args.verbose ? "verbose" : "normal",
        stream: io.stderr,
        color: useColor(io.stderr, env),
      });
      // A protected preview checked as a site: the secret goes to the checked origin only.
      const auth: PreviewAuth | undefined = previewAuth(io.env ?? {}, new URL(args.address).origin);
      const fetcher = createFetcher({
        ...deps.fetcher,
        ...(args.allowPrivate ? { allowPrivate: true } : {}),
        ...(auth ? { headersFor: authHeaders(auth) } : {}),
        onRequest: (info) => log.request(info),
      });
      if (!args.quiet) {
        // The query string can carry a token, so the header shows the address without it.
        io.stderr.write(
          `Gaugeline ${VERSION} checking ${withoutQuery(args.address)}${auth ? ` (${auth.describe})` : ""}\n`,
        );
        if (auth?.warning) io.stderr.write(`${auth.warning}\n`);
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
        contents,
        contentNotes,
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
        ...(navRules ? { nav: navRules } : {}),
        ...(tags ? { tags } : {}),
        // No observer until rendered reads (G39): the click event checks are could not check.
        ...(events ? { events } : {}),
        ...(last?.kind === "ok" ? { previous: last.snapshot } : {}),
        ...(args.since === "last" ? { baselineRequested: true } : {}),
        ...(pagesConfig ? { pagesConfig } : {}),
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
      // Gains since the last run: information on stderr, never findings.
      if (contentNotes && contentNotes.length > 0 && !args.json && !args.quiet)
        io.stderr.write(`Since the last run:\n${contentNotes.map((l) => `  ${l}`).join("\n")}\n`);
      if (args.since && last?.kind !== "newer")
        writeLastRun(
          cwd,
          host,
          buildRunSnapshot(snapshot, () => startedAt, contents),
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

/** A file the command was given, as text: one plain sentence when it can't be read. */
function readText(path: string, shown: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`${shown} could not be read.`);
  }
}

function describeLive(format: LiveRead | undefined): string {
  if (!format) return "an empty file";
  return `${LIVE_NAMES[format.format]}${format.metric ? `, sorted by ${format.metric}` : ""}`;
}

/** How --live's detected format is named on stderr. */
const LIVE_NAMES: Readonly<Record<LiveRead["format"], string>> = {
  crawl: "a crawl export",
  "search-console": "a Search Console export",
  sitemap: "a sitemap",
  list: "a list of addresses",
};
