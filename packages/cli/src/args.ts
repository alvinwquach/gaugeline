import { parseArgs } from "node:util";
import { parseAddress } from "@gaugeline/core";
import { HELP } from "./help.js";
import { FLAGS, nearestFlag, resolveFlags, toParseArgsOptions, type FlagDef } from "./flags.js";

export const USAGE_LINE = "gaugeline <address> [options]";
export const COMMAND = "check";
/** Subcommands, by their first word on the command line. "check" is the default. */
export const SUBCOMMANDS = ["launch", "view", "digest", "plan"] as const;
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
  /** --since last: compare with the stored last run and replace it. */
  since?: "last";
  /** -i, --interactive: open the terminal view after the run. */
  interactive: boolean;
  /** Channel addresses given as flags (the environment can supply them too). */
  notify: { slack?: string; discord?: string; webhook?: string; email?: string };
  notifyOn: "any" | "high" | "always";
  reportUrl?: string;
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
            : COMMAND;
  const rest = command === COMMAND ? argv : argv.slice(1);
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
