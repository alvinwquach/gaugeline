import { parseArgs } from "node:util";
import { SECRET_FLAGS, parseAddress } from "@gaugeline/core";
import { HELP } from "./help.js";
import { FLAGS, nearestFlag, resolveFlags, toParseArgsOptions, type FlagDef } from "./flags.js";

export const USAGE_LINE = "gaugeline <address> [options]";
export const COMMAND = "check";
/** Subcommands, by their first word on the command line. "check" is the default. */
export const SUBCOMMANDS = [
  "launch",
  "view",
  "digest",
  "plan",
  "printed",
  "snapshot",
  "cutover",
  "verify",
  "run",
  "open",
  "assert",
] as const;
export type CliCommand = "check" | (typeof SUBCOMMANDS)[number];

/** The root command's help, from help.ts. */
export const USAGE = HELP[""] ?? "";

export const USAGE_HINT = `${USAGE_LINE}, for example: gaugeline example.com (see gaugeline --help)`;
export const UNKNOWN_FLAG_HINT = "Run gaugeline --help to see every option.";

export interface RunFlags {
  /** Which command: the default page check, or launch. */
  command: CliCommand;
  /** launch --dns: add the email record checks. */
  dns: boolean;
  /** --allow-secret-key: use a Stripe secret key (with a notice) instead of refusing it. */
  allowSecretKey: boolean;
  /** --since last: compare with the stored last run and replace it. */
  since?: "last";
  /** -i, --interactive: open the terminal view after the run. */
  interactive: boolean;
  /** Channel addresses given as flags (the environment can supply them too). */
  notify: { slack?: string; discord?: string; webhook?: string; email?: string };
  notifyOn: "any" | "high" | "always";
  reportUrl?: string;
  /** --save-requests: where to write the request log and page data (a separate file, never the result). */
  saveRequests?: string;
  ci: boolean;
  json: boolean;
  noOpen: boolean;
  verbose: boolean;
  quiet: boolean;
  allowPrivate: boolean;
}

export type ParsedArgs =
  | { kind: "help"; verbose: boolean; command: CliCommand }
  | { kind: "version"; verbose: boolean }
  | { kind: "view"; file: string; verbose: boolean }
  | {
      kind: "plan";
      file: string;
      planOnly: boolean;
      sheet?: string;
      legacyFrom: string[];
      legacyReview?: string;
      /** "" when given without a file name: the default name is used. */
      annotate?: string;
      force: boolean;
      /** "" when given without a file name: the state file beside the plan. */
      progress?: string;
      /** --watch: the cutover date, YYYY-MM-DD (the 30-day watch). */
      watch?: string;
      /** Where to send the findings the run shows (with --watch, only the new ones). */
      notify: { slack?: string; discord?: string; webhook?: string };
      notifyOn: "any" | "high" | "always";
      all: boolean;
      printed?: string;
      live?: string;
      rank?: string;
      /** --nav: [] for every tab headed Main category, or the tabs named. Absent without --nav. */
      nav?: string[];
      ignore: string[];
      base?: string;
      allowPrivate: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "printed";
      file: string;
      /** Images (or folders) to read QR codes from: --decode values and the positionals after the file. */
      decode: string[];
      tags?: string[];
      allowPrivate: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "snapshot";
      domain: string;
      out: string;
      allowPrivate: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | { kind: "cutover"; before: string; allowPrivate: boolean; verbose: boolean; quiet: boolean }
  | {
      kind: "open";
      address?: string;
      noOpen: boolean;
      /** gaugeline open --demo: example results, no fetcher, no address. */
      demo: boolean;
      /** gaugeline open --ads <file>: the export to read, from the command line only. */
      ads?: string;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "run-all";
      all: boolean;
      sites: string[];
      tag?: string;
      parallel: number;
      allowPrivate: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "verify";
      file: string;
      limit: number;
      ci: boolean;
      allowPrivate: boolean;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "assert";
      /** gaugeline assert --list: print the assertions and run none. */
      list: boolean;
      /** gaugeline assert <id>: the one assertion to run. */
      id?: string;
      verbose: boolean;
      quiet: boolean;
    }
  | {
      kind: "digest";
      runs: string;
      timeZone?: string;
      notify: { email?: string; webhook?: string };
      verbose: boolean;
      quiet: boolean;
    }
  | ({ kind: "run"; address: string; input: string; deprecatedUsed: FlagDef[] } & RunFlags)
  | { kind: "error"; message: string; hint?: string; verbose: boolean };

/** Turn a parseArgs error into one sentence naming the flag, plus a hint. */
export function describeParseError(
  err: unknown,
  flags: readonly FlagDef[] = FLAGS,
  command = COMMAND,
): { message: string; hint: string } {
  const code = (err as { code?: string }).code;
  const text = err instanceof Error ? err.message : String(err);
  const flag = /'(-[^' ]+)/.exec(text)?.[1] ?? "";
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    // A known flag on a command that does not take it: say which commands do.
    if (flag.split("=")[0] === "--save-requests")
      return {
        message: `--save-requests only works with the page check (gaugeline <address>) and gaugeline launch, not with gaugeline ${command}.`,
        hint: "Run it on one address: gaugeline example.com --save-requests requests.json.",
      };
    const near = nearestFlag(flag, flags, command);
    return {
      message: `Unknown option ${flag}.${near ? ` Did you mean --${near}?` : ""}`,
      hint: UNKNOWN_FLAG_HINT,
    };
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    return { message: `${flag} needs a value.`, hint: UNKNOWN_FLAG_HINT };
  }
  return {
    message: `${(text.split("\n")[0] ?? text).replace(/\.?$/, ".")}`,
    hint: UNKNOWN_FLAG_HINT,
  };
}

export function parseCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
  flags: readonly FlagDef[] = FLAGS,
): ParsedArgs {
  const verbose = argv.includes("--verbose");
  const command: CliCommand =
    argv[0] === "launch"
      ? "launch"
      : argv[0] === "view"
        ? "view"
        : argv[0] === "digest"
          ? "digest"
          : argv[0] === "plan"
            ? "plan"
            : argv[0] === "printed"
              ? "printed"
              : argv[0] === "snapshot"
                ? "snapshot"
                : argv[0] === "cutover"
                  ? "cutover"
                  : argv[0] === "verify"
                    ? "verify"
                    : argv[0] === "run"
                      ? "run"
                      : argv[0] === "open"
                        ? "open"
                        : argv[0] === "assert"
                          ? "assert"
                          : COMMAND;
  const given = command === COMMAND ? argv : argv.slice(1);
  // --annotate and --progress take an optional file name: alone, or before another flag, the default.
  const rest = given.map((a, i) =>
    (a === "--annotate" || a === "--progress" || a === "--nav") &&
    (given[i + 1] === undefined || given[i + 1]?.startsWith("-"))
      ? `${a}=`
      : a,
  );
  // No flag takes a secret: a value on the command line lands in shell history and CI logs.
  for (const a of rest) {
    const name = /^--([a-z-]+)(?:=|$)/.exec(a)?.[1];
    const variable = name !== undefined ? SECRET_FLAGS[name] : undefined;
    if (name !== undefined && variable !== undefined)
      return {
        kind: "error",
        message: `--${name}: no option takes a password or token. Set ${variable} in the environment instead.`,
        hint: "Secrets are read only from environment variables and never printed (see docs/plan-check).",
        verbose,
      };
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      strict: true,
      options: toParseArgsOptions(flags, command),
    });
  } catch (err) {
    return { kind: "error", ...describeParseError(err, flags, command), verbose };
  }
  const values = resolveFlags(parsed.values, env, flags);
  const deprecatedUsed = flags.filter((f) => f.deprecated && parsed.values[f.name] !== undefined);
  if (values.quiet === true && values.verbose === true) {
    return { kind: "error", message: "Choose --quiet or --verbose, not both.", verbose: false };
  }
  if (values.help === true) return { kind: "help", verbose, command };
  const notifyOn = values["notify-on"] ?? "any";
  if (notifyOn !== "any" && notifyOn !== "high" && notifyOn !== "always") {
    return {
      kind: "error",
      message: `--notify-on accepts any, high or always, not "${String(notifyOn)}".`,
      hint: UNKNOWN_FLAG_HINT,
      verbose,
    };
  }
  if (values.since !== undefined && values.since !== "last") {
    return {
      kind: "error",
      message: `--since accepts only last in this version, not "${String(values.since)}".`,
      hint: "Use --since last to compare with the previous run of this site.",
      verbose,
    };
  }
  if (values.version === true) return { kind: "version", verbose };
  if (typeof values["save-requests"] === "string" && values["save-requests"].trim() === "") {
    return {
      kind: "error",
      message: "--save-requests needs a file name.",
      hint: "For example: gaugeline example.com --save-requests requests.json.",
      verbose,
    };
  }

  const positionals = parsed.positionals.map((p) => p.trim()).filter((p) => p !== "");
  if (command === "plan") {
    if (positionals.length !== 1)
      return {
        kind: "error",
        message: "gaugeline plan needs one plan file: gaugeline plan sitemap.csv",
        hint: "Export the plan from your spreadsheet as CSV.",
        verbose,
      };
    return {
      kind: "plan",
      file: positionals[0] ?? "",
      planOnly: values["plan-only"] === true,
      ...(typeof values.sheet === "string" ? { sheet: values.sheet } : {}),
      legacyFrom: Array.isArray(values["legacy-from"])
        ? values["legacy-from"]
        : typeof values["legacy-from"] === "string"
          ? [values["legacy-from"]]
          : [],
      ...(typeof values.annotate === "string" ? { annotate: values.annotate } : {}),
      force: values.force === true,
      ...(typeof values.progress === "string" ? { progress: values.progress } : {}),
      ...(typeof values.watch === "string" ? { watch: values.watch } : {}),
      notify: {
        ...(typeof values.slack === "string" ? { slack: values.slack } : {}),
        ...(typeof values.discord === "string" ? { discord: values.discord } : {}),
        ...(typeof values.webhook === "string" ? { webhook: values.webhook } : {}),
      },
      notifyOn,
      all: values.all === true,
      ...(typeof values.printed === "string" ? { printed: values.printed } : {}),
      ...(typeof values.live === "string" ? { live: values.live } : {}),
      ...(typeof values.rank === "string" ? { rank: values.rank } : {}),
      ...(typeof values.nav === "string"
        ? {
            nav: values.nav
              .split(",")
              .map((n) => n.trim())
              .filter((n) => n !== ""),
          }
        : {}),
      ignore: Array.isArray(values.ignore)
        ? values.ignore
        : typeof values.ignore === "string"
          ? [values.ignore]
          : [],
      ...(typeof values.base === "string" ? { base: values.base } : {}),
      allowPrivate: values["allow-private"] === true,
      ...(typeof values["legacy-review"] === "string"
        ? { legacyReview: values["legacy-review"] }
        : {}),
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "printed") {
    const decodeValues = Array.isArray(values.decode)
      ? values.decode
      : typeof values.decode === "string"
        ? [values.decode]
        : [];
    // A shell expands --decode ./flyers/*.png into one value and more positionals: those are images too.
    if (positionals.length === 0 || (decodeValues.length === 0 && positionals.length > 1))
      return {
        kind: "error",
        message: "gaugeline printed needs one register file: gaugeline printed printed.csv",
        hint: "Columns: url, where, printedOn, expectedDestination. Add --decode <images> to read QR codes.",
        verbose,
      };
    const tags =
      typeof values.tags === "string"
        ? values.tags
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t !== "")
        : undefined;
    return {
      kind: "printed",
      file: positionals[0] ?? "",
      decode: [...decodeValues, ...positionals.slice(1)],
      ...(tags && tags.length > 0 ? { tags } : {}),
      allowPrivate: values["allow-private"] === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "snapshot") {
    const domain = (positionals[0] ?? "").trim();
    if (positionals.length !== 1 || !/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(domain.replace(/\.$/, "")))
      return {
        kind: "error",
        message:
          "gaugeline snapshot needs one domain: gaugeline snapshot example.com --out before.json",
        hint: "Give the bare domain, without https:// or a path.",
        verbose,
      };
    return {
      kind: "snapshot",
      domain,
      out: typeof values.out === "string" && values.out !== "" ? values.out : "before.json",
      allowPrivate: values["allow-private"] === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "open") {
    if (positionals.length > 1)
      return {
        kind: "error",
        message: `gaugeline open takes at most one address, got ${positionals.length}.`,
        hint: "Run gaugeline open on its own, or gaugeline open yoursite.com.",
        verbose,
      };
    // The demo shows example results and checks nothing, so an address has nothing to do there.
    if (values.demo === true && positionals.length > 0)
      return {
        kind: "error",
        message:
          "gaugeline open --demo takes no address: it shows example results and checks nothing.",
        hint: "Run gaugeline open --demo on its own, or gaugeline open yoursite.com to check a real page.",
        verbose,
      };
    const ads = values.ads;
    if (ads !== undefined && (typeof ads !== "string" || ads.trim() === ""))
      return {
        kind: "error",
        message: "--ads needs the ads export file: gaugeline open --ads ads-export.csv.",
        hint: "Export your ads from Meta Ads Manager or Google Ads as CSV and keep the link and amount-spent columns.",
        verbose,
      };
    // Two ways to fill the app that cannot both be: the demo shows example results about invented
    // sites, and an export is the person's own file.
    if (ads !== undefined && values.demo === true)
      return {
        kind: "error",
        message:
          "gaugeline open --demo and --ads cannot be used together: the demo shows example results, and --ads shows your own export.",
        hint: "Run gaugeline open --demo on its own, or gaugeline open --ads ads-export.csv.",
        verbose,
      };
    if (ads !== undefined && positionals.length > 0)
      return {
        kind: "error",
        message:
          "gaugeline open --ads takes no address: it shows the landing pages in the export, and checks nothing else.",
        hint: "Run gaugeline open --ads ads-export.csv on its own, or gaugeline open yoursite.com to check one page.",
        verbose,
      };
    return {
      kind: "open",
      ...(positionals[0] ? { address: positionals[0] } : {}),
      noOpen: values["no-open"] === true,
      demo: values.demo === true,
      ...(typeof ads === "string" ? { ads } : {}),
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "run") {
    const names = Array.isArray(values.site)
      ? values.site
      : typeof values.site === "string"
        ? [values.site]
        : [];
    const tag = typeof values.tag === "string" ? values.tag : undefined;
    const all = values.all === true;
    if (
      (all ? 1 : 0) + (names.length > 0 ? 1 : 0) + (tag !== undefined ? 1 : 0) !== 1 ||
      positionals.length > 0
    )
      return {
        kind: "error",
        message: "gaugeline run needs one of --all, --site <name> or --tag <tag>.",
        hint: "The sites are listed in gaugeline.sites.json, in the folder you run from.",
        verbose,
      };
    const p = typeof values.parallel === "string" ? values.parallel.trim() : "1";
    if (!/^[1-9]\d*$/.test(p))
      return {
        kind: "error",
        message: `--parallel takes a number of sites at once, 1 or more, not "${p}".`,
        hint: UNKNOWN_FLAG_HINT,
        verbose,
      };
    return {
      kind: "run-all",
      all,
      sites: names,
      ...(tag !== undefined ? { tag } : {}),
      parallel: Number(p),
      allowPrivate: values["allow-private"] === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "verify") {
    if (positionals.length !== 1)
      return {
        kind: "error",
        message: "gaugeline verify needs one crawler export: gaugeline verify crawl-export.csv",
        hint: "Export the audit's URLs as CSV from your crawler (an Address or URL column).",
        verbose,
      };
    const limitText = typeof values.limit === "string" ? values.limit.trim() : "40";
    if (!/^\d+$/.test(limitText))
      return {
        kind: "error",
        message: `--limit takes a whole number of pages, not "${limitText}".`,
        hint: "For example --limit 40, or --limit 0 to classify the rows only.",
        verbose,
      };
    return {
      kind: "verify",
      file: positionals[0] ?? "",
      limit: Number(limitText),
      ci: values.ci === true,
      allowPrivate: values["allow-private"] === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "assert") {
    const list = values.list === true;
    if (
      positionals.length > 1 ||
      (list && positionals.length > 0) ||
      (!list && positionals.length === 0)
    )
      return {
        kind: "error",
        message:
          list || positionals.length > 1
            ? "gaugeline assert takes one assertion id, or --list on its own."
            : "gaugeline assert needs an assertion id: gaugeline assert no-overlapping-bookings",
        hint: "Run gaugeline assert --list to see the assertions in gaugeline.sources.json.",
        verbose,
      };
    return {
      kind: "assert",
      list,
      ...(positionals[0] ? { id: positionals[0] } : {}),
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "cutover") {
    if (typeof values.before !== "string" || values.before === "" || positionals.length > 0)
      return {
        kind: "error",
        message:
          "gaugeline cutover needs the snapshot taken before: gaugeline cutover --before before.json",
        hint: "Take one first with gaugeline snapshot example.com --out before.json.",
        verbose,
      };
    return {
      kind: "cutover",
      before: values.before,
      allowPrivate: values["allow-private"] === true,
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "digest") {
    const runs = typeof values.runs === "string" ? values.runs.trim() : (positionals[0] ?? "");
    if (runs === "")
      return {
        kind: "error",
        message: "gaugeline digest needs the folder of saved runs: gaugeline digest --runs runs",
        hint: "Save each run with gaugeline <address> --json > runs/<date>.json.",
        verbose,
      };
    return {
      kind: "digest",
      runs,
      ...(typeof values["time-zone"] === "string" ? { timeZone: values["time-zone"] } : {}),
      notify: {
        ...(typeof values.email === "string" ? { email: values.email } : {}),
        ...(typeof values.webhook === "string" ? { webhook: values.webhook } : {}),
      },
      verbose,
      quiet: values.quiet === true,
    };
  }
  if (command === "view") {
    if (positionals.length !== 1)
      return {
        kind: "error",
        message: "gaugeline view needs one saved run: gaugeline view run.json",
        hint: "Save a run with gaugeline <address> --json > run.json.",
        verbose,
      };
    return { kind: "view", file: positionals[0] ?? "", verbose };
  }
  if (positionals.length === 0) {
    return { kind: "error", message: "No address given.", hint: USAGE_HINT, verbose };
  }
  if (positionals.length > 1) {
    return {
      kind: "error",
      message: `Expected one address, got ${positionals.length}: ${positionals.join(", ")}.`,
      hint: USAGE_HINT,
      verbose,
    };
  }
  const input = positionals[0] ?? "";
  const address = parseAddress(input);
  if (!address.ok) {
    return {
      kind: "error",
      message: address.reason,
      hint: "Type an address like example.com or https://example.com/.",
      verbose,
    };
  }
  return {
    kind: "run",
    command,
    dns: values.dns === true,
    allowSecretKey: values["allow-secret-key"] === true,
    interactive: values.interactive === true,
    notify: {
      ...(typeof values.slack === "string" ? { slack: values.slack } : {}),
      ...(typeof values.discord === "string" ? { discord: values.discord } : {}),
      ...(typeof values.webhook === "string" ? { webhook: values.webhook } : {}),
      ...(typeof values.email === "string" ? { email: values.email } : {}),
    },
    notifyOn,
    ...(typeof values["report-url"] === "string" ? { reportUrl: values["report-url"] } : {}),
    ...(values.since === "last" ? { since: "last" as const } : {}),
    ...(typeof values["save-requests"] === "string"
      ? { saveRequests: values["save-requests"] }
      : {}),
    address: address.url.href,
    input,
    deprecatedUsed,
    verbose,
    quiet: values.quiet === true,
    allowPrivate: values["allow-private"] === true,
    ci: values.ci === true,
    json: values.json === true,
    noOpen: values["no-open"] === true,
  };
}
